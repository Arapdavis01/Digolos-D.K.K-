"use client";

import { useChat } from "ai/react";
import { createClient } from "@/utils/supabase/client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

export default function ChatPage() {
  const router = useRouter();
  const supabase = createClient();
  const [user, setUser] = useState<any>(null);
  const [conversations, setConversations] = useState<any[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);

  // Load user
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.push("/auth");
      else setUser(data.user);
    });
  }, [router, supabase]);

  // Fetch conversation list
  const fetchConversations = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("conversations")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setConversations(data || []);
  }, [user, supabase]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // State to hold loaded messages when selecting an existing conversation
  const [initialMessages, setInitialMessages] = useState<any[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const handleSelectConversation = async (convId: string) => {
    setActiveConvId(convId);
    setLoadingMessages(true);
    const { data: messages } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });
    const formatted = messages?.map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
    })) || [];
    setInitialMessages(formatted);
    setLoadingMessages(false);
  };

  // Reset for a new chat
  const handleNewChat = () => {
    setActiveConvId(null);
    setInitialMessages([]);
  };

  // useChat with controlled initialMessages; resets when id changes
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: "/api/chat",
    initialMessages: activeConvId ? initialMessages : [],
    body: {
      conversationId: activeConvId,
    },
    onFinish: () => {
      fetchConversations();
    },
    id: activeConvId || "new", // unique key to force re-mount on new/switch
  });

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/auth");
  };

  return (
    <div className="flex h-screen bg-white">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-gray-50 p-4 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Digolos D.K.K</h2>
        </div>
        <button
          onClick={handleNewChat}
          className="w-full mb-4 rounded-lg border border-black bg-black px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          + New Chat
        </button>
        <div className="flex-1 overflow-y-auto space-y-2">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => handleSelectConversation(conv.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                activeConvId === conv.id
                  ? "bg-gray-200 font-medium"
                  : "hover:bg-gray-100"
              }`}
            >
              {conv.title || "Untitled chat"}
            </button>
          ))}
        </div>
        {user && (
          <div className="mt-auto pt-4 border-t">
            <p className="text-xs text-gray-500 truncate">{user.email}</p>
            <button
              onClick={handleLogout}
              className="mt-2 w-full rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100"
            >
              Logout
            </button>
          </div>
        )}
      </aside>

      {/* Main chat area – always visible */}
      <main className="flex-1 flex flex-col">
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loadingMessages ? (
            <p className="text-gray-500">Loading conversation...</p>
          ) : messages.length === 0 ? (
            // Welcome screen when no messages (new conversation)
            <div className="flex flex-col items-center justify-center h-full text-center">
              <h1 className="text-3xl font-bold mb-2">Digolos D.K.K</h1>
              <p className="text-gray-500 mb-8">
                Your intelligent assistant. Start a new chat or pick a previous one.
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className="flex flex-col">
                <div className="text-xs font-semibold text-gray-500 mb-1">
                  {m.role === "user" ? "You" : "Digolos D.K.K"}
                </div>
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                    m.role === "user"
                      ? "bg-gray-100 self-end"
                      : "bg-blue-50 self-start"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))
          )}
          {isLoading && (
            <div className="text-gray-400 text-sm animate-pulse">
              Digolos D.K.K is thinking...
            </div>
          )}
        </div>

        {/* Input always shown at bottom */}
        <form
          onSubmit={handleSubmit}
          className="border-t p-4 flex gap-3 bg-white"
        >
          <input
            value={input}
            onChange={handleInputChange}
            placeholder="Message Digolos D.K.K..."
            className="flex-1 rounded-xl border border-gray-300 px-4 py-3 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading}
            className="rounded-xl bg-black px-5 py-3 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </main>
    </div>
  );
}
