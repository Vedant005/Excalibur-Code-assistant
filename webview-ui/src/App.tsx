// webview-ui/src/App.tsx
import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
// Extend the Message interface
interface Message {
  id?: number; // Optional ID for updating messages during streaming
  sender: "user" | "ai";
  text: string;
  streaming?: boolean; // Indicates if this message is currently being streamed
}

// VS Code API type declaration
declare const vscode: {
  postMessage: ({ command, text }: { command: string; text?: string }) => void;
};

function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [context, setContext] = useState<{
    fileName: string;
    content: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null); // For auto-scrolling

  // Function to scroll to the bottom of the chat
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    // Log a message to the extension host console when the React app loads
    vscode.postMessage({ command: "log", text: "React app loaded and ready!" });

    window.addEventListener("message", (event) => {
      const message = event.data;
      switch (message.command) {
        case "addMessage":
          // Add new message, including the AI's initial streaming message
          setMessages((prevMessages) => [...prevMessages, message.message]);
          break;
        case "updateMessage":
          setMessages((prevMessages) =>
            prevMessages.map((msg) =>
              msg.id === message.message.id
                ? {
                    ...msg,
                    text: message.message.text,
                    streaming: message.message.streaming,
                  }
                : msg
            )
          );
          break;
        case "displayContext":
          setContext(message.context);
          break;
      }
    });
  }, []);

  useEffect(() => {
    scrollToBottom(); // Scroll whenever messages change
  }, [messages]);

  const handleSendMessage = () => {
    if (input.trim()) {
      setMessages((prevMessages) => [
        ...prevMessages,
        { sender: "user", text: input.trim() },
      ]);
      vscode.postMessage({
        command: "sendMessage",
        text: input.trim(),
      });
      setInput("");
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // Send on Enter, allow Shift+Enter for new line (if input was textarea)
      e.preventDefault(); // Prevent default Enter behavior (e.g., new line)
      handleSendMessage();
    }
  };

  return (
    <div className="flex flex-col h-screen p-2 box-border bg-vscode-background text-vscode-foreground">
      <div className="flex-1 overflow-y-auto p-2 border border-vscode-editorGroupHeaderBorder rounded-md mb-2">
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`mb-2 p-2 rounded-md ${
              msg.sender === "user"
                ? "bg-vscode-buttonBackground text-right"
                : "bg-vscode-inputBackground text-left"
            }`}
          >
            <span className="font-bold">
              {msg.sender === "user" ? "You:" : "AI:"}
            </span>
            {msg.sender === "user" ? (
              msg.text // User messages don't need Markdown
            ) : (
              <ReactMarkdown>{msg.text}</ReactMarkdown> // <-- Render AI messages with Markdown
            )}
            {msg.streaming && msg.sender === "ai" && (
              <span className="animate-pulse ml-2">...</span>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
        {/* For auto-scrolling */}
      </div>

      {context && (
        <div className="bg-vscode-buttonHoverBackground p-2 my-2 rounded-md overflow-auto max-h-24">
          <h3 className="font-bold">Current Context: {context.fileName}</h3>
          <pre className="text-sm whitespace-pre-wrap">{context.content}</pre>
        </div>
      )}

      <button
        onClick={() => vscode.postMessage({ command: "requestContext" })}
        className="px-4 py-2 bg-vscode-buttonBackground text-vscode-buttonForeground rounded-md cursor-pointer hover:bg-vscode-buttonHoverBackground focus:outline-none focus:ring-1 focus:ring-vscode-buttonBackground mb-2"
      >
        Get Current File Context
      </button>

      <div className="flex">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleInputKeyDown}
          className="flex-1 p-2 border border-vscode-inputBorder rounded-l-md bg-vscode-inputBackground text-vscode-inputForeground focus:outline-none focus:border-vscode-focusBorder"
          placeholder="Type your message..."
        />
        <button
          onClick={handleSendMessage}
          className="px-4 py-2 bg-vscode-buttonBackground text-vscode-buttonForeground rounded-r-md cursor-pointer hover:bg-vscode-buttonHoverBackground focus:outline-none focus:ring-1 focus:ring-vscode-buttonBackground"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default App;
