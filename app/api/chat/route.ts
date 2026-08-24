import { NextResponse } from "next/server";
import OpenAI from "openai";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "API key missing" }, { status: 500 });
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { messages, conversationId } = await req.json();

  // Create conversation if needed
  let convId = conversationId;
  if (!convId) {
    const { data: conv, error } = await supabase
      .from("conversations")
      .insert({
        user_id: user.id,
        title: messages[0]?.content?.substring(0, 100) || "New chat",
      })
      .select("id")
      .single();
    if (error) return NextResponse.json({ error: "Conversation creation failed" }, { status: 500 });
    convId = conv.id;
  }

  // Save user message
  const lastUser = messages[messages.length - 1];
  if (lastUser.role === "user") {
    await supabase.from("messages").insert({
      conversation_id: convId,
      role: "user",
      content: lastUser.content,
    });
  }

  const systemPrompt = `You are Digolos D.K.K, a helpful, witty, and knowledgeable AI assistant.`;
  const fullMessages = [{ role: "system", content: systemPrompt }, ...messages];

  // Known good chat models on Groq (updated Jan 2025)
  const candidateModels = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "llama-3.2-11b-vision-preview",
    "llama-3.2-90b-vision-preview",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
    "deepseek-r1-distill-llama-70b",
    "qwen-2.5-32b",
    "qwen-2.5-coder-32b",
  ];

  let chosenModel = "";
  let streamSupported = true;

  // Try streaming first on each candidate
  for (const model of candidateModels) {
    try {
      // Test with a tiny request to check availability and streaming
      const test = await openai.chat.completions.create({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: true,
      });
      // Consume the stream to ensure it works
      for await (const _ of test) break;
      chosenModel = model;
      break;
    } catch (err: any) {
      // If streaming not supported, try non-streaming for this model
      if (err.code === "invalid_request_error" && err.message?.includes("streaming")) {
        streamSupported = false;
        try {
          const test2 = await openai.chat.completions.create({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          });
          chosenModel = model;
          break;
        } catch {}
      }
      // Otherwise continue to next model
      continue;
    }
  }

  if (!chosenModel) {
    return NextResponse.json({ error: "No suitable Groq model available" }, { status: 500 });
  }

  // Now call the real completion
  try {
    if (streamSupported) {
      // Streaming path
      const completion = await openai.chat.completions.create({
        model: chosenModel,
        stream: true,
        messages: fullMessages as any,
      });

      let assistantContent = "";
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              assistantContent += delta;
              controller.enqueue(encoder.encode(delta));
            }
          }
          controller.close();
        },
      });

      const response = new Response(stream, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });

      // Save assistant message after streaming completes
      (async () => {
        // Wait a bit to ensure stream is fully read
        await new Promise((r) => setTimeout(r, 1000));
        if (assistantContent) {
          await supabase.from("messages").insert({
            conversation_id: convId,
            role: "assistant",
            content: assistantContent,
          });
        }
      })();

      return response;
    } else {
      // Non-streaming fallback
      const completion = await openai.chat.completions.create({
        model: chosenModel,
        messages: fullMessages as any,
      });

      const assistantContent = completion.choices[0]?.message?.content || "";
      await supabase.from("messages").insert({
        conversation_id: convId,
        role: "assistant",
        content: assistantContent,
      });

      return NextResponse.json({ content: assistantContent });
    }
  } catch (error: any) {
    console.error("Final Groq error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
