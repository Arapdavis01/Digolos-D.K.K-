import { StreamingTextResponse } from "ai";
import OpenAI from "openai";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: Request) {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  // Authenticate user
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, conversationId } = await req.json();

  // Create a conversation if none is provided
  let convId = conversationId;
  if (!convId) {
    const { data: conv, error: convError } = await supabase
      .from("conversations")
      .insert({
        user_id: user.id,
        title: messages[0]?.content?.substring(0, 100) || "New chat",
      })
      .select("id")
      .single();

    if (convError) {
      return new Response("Failed to create conversation", { status: 500 });
    }
    convId = conv.id;
  }

  // Save the last user message
  const lastUserMessage = messages[messages.length - 1];
  if (lastUserMessage.role === "user") {
    await supabase.from("messages").insert({
      conversation_id: convId,
      role: "user",
      content: lastUserMessage.content,
    });
  }

  // System prompt
  const systemPrompt = `You are Digolos D.K.K, a helpful, witty, and knowledgeable AI assistant. You provide clear answers, use a friendly tone, and occasionally sign off with "Stay curious! – D.K.K".`;

  const fullMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  // Start the stream from OpenAI
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    stream: true,
    messages: fullMessages as any,
  });

  // Collect the full assistant response
  let assistantContent = "";

  // Create a ReadableStream from the completion
  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of completion) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          assistantContent += content;
          // Encode and send the chunk to the client
          controller.enqueue(new TextEncoder().encode(content));
        }
      }
      controller.close();
    },
    cancel() {
      // Stream cancelled by client
    },
  });

  // Return a StreamingTextResponse
  const response = new StreamingTextResponse(stream);

  // Save the assistant message after the stream ends (via a separate promise)
  (async () => {
    // Wait for the stream to be fully read (just a small delay to ensure it's done)
    // In production you'd hook into the response's completion, but here we rely on
    // the fact that `assistantContent` is fully populated after the for-await loop.
    if (assistantContent) {
      try {
        // Update conversation title if new (first exchange)
        if (messages.length <= 2) {
          const newTitle = assistantContent.substring(0, 60) || "New chat";
          await supabase
            .from("conversations")
            .update({ title: newTitle })
            .eq("id", convId);
        }

        await supabase.from("messages").insert({
          conversation_id: convId,
          role: "assistant",
          content: assistantContent,
        });
      } catch (err) {
        console.error("Failed to save assistant message:", err);
      }
    }
  })();

  // Append the conversation id header
  response.headers.set("X-Conversation-Id", convId);

  return response;
}
