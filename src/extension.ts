import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";

console.log("DEBUG: Current Working Directory:", process.cwd());

let panel: vscode.WebviewPanel | undefined; // Keep a reference to the panel

let OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "deepseek/deepseek-r1-0528-qwen3-8b:free";

let chatHistory: { role: string; content: string }[] = [];

async function callOpenRouter(
  prompt: string,
  currentHistory: { role: string; content: string }[],
  // Add a callback function for streamed chunks
  onChunk: (chunk: string) => void
): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      "OpenRouter API key is not set. Please add OPENROUTER_API_KEY to your .env file or check extension setup."
    );
  }

  try {
    const messages = currentHistory.concat([{ role: "user", content: prompt }]);

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://your-extension-id.example.com",
        "X-Title": "VS Code AI Chat Assistant",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: messages,
        stream: true, // <-- IMPORTANT: Enable streaming
      }),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      console.error("OpenRouter API Raw Error:", errorText);
      throw new Error(
        `OpenRouter API error: ${response.status} - ${errorText}`
      );
    }

    let fullResponseContent = "";
    const reader = (
      response.body as unknown as ReadableStream<Uint8Array>
    ).getReader();
    const decoder = new TextDecoder("utf-8");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // OpenRouter (and OpenAI) stream responses are EventSource format (data: ...)
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.substring(6);
          if (data === "[DONE]") {
            break; // End of stream
          }
          try {
            const json = JSON.parse(data);
            const content = json.choices[0]?.delta?.content || "";
            if (content) {
              fullResponseContent += content;
              onChunk(content); // Call the callback with the new chunk
            }
          } catch (e) {
            console.warn("Could not parse stream chunk:", e, data);
          }
        }
      }
    }

    return fullResponseContent; // Return the complete response
  } catch (error: any) {
    console.error("Error calling OpenRouter API:", error);
    vscode.window.showErrorMessage(`OpenRouter error: ${error.message}`);
    return `Error: ${error.message}`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const envPath = path.join(context.extensionPath, ".env");
  const dotenvConfigResult = dotenv.config({ path: envPath });

  if (dotenvConfigResult.error) {
    console.error(
      "DOTENV_ERROR: Failed to load .env file from:",
      envPath,
      dotenvConfigResult.error
    );
    vscode.window.showErrorMessage(
      "Failed to load .env file. Check console for details."
    );
  } else {
    console.log("DOTENV_SUCCESS: .env file loaded successfully from:", envPath);
    // Assign the API key *after* dotenv has loaded it
    OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  }

  console.log(
    "DEBUG: OPENROUTER_API_KEY from process.env:",
    OPENROUTER_API_KEY ? "****** (Key Loaded)" : "UNDEFINED"
  );
  console.log("DEBUG: Current Working Directory:", process.cwd());

  console.log("--- Extension activate function started ---");
  console.log(
    'Congratulations, your extension "ai-chat-assistant" is now active!'
  );

  let disposable = vscode.commands.registerCommand(
    "excalibur.startChat",
    () => {
      // Check if we already have a panel. If so, reveal it.
      if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        return;
      }

      // Create a new webview panel
      panel = vscode.window.createWebviewPanel(
        "aiChat", // Unique ID to identify the type of the webview
        "AI Chat Assistant", // Title of the panel displayed to the user
        vscode.ViewColumn.One, // Editor column to show the new webview panel in.
        {
          enableScripts: true,

          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist"),
          ],
        }
      );

      // Set the HTML content for the webview
      panel.webview.html = getWebviewContent(
        panel.webview,
        context.extensionUri
      );

      // Handle messages from the webview
      panel.webview.onDidReceiveMessage(
        async (message) => {
          switch (message.command) {
            case "alert":
              vscode.window.showErrorMessage(message.text);
              return;
            case "log":
              console.log("Message from WebView:", message.text);
              return;
            case "sendMessage":
              console.log("User message from React:", message.text);
              const userMessage = message.text;

              chatHistory.push({ role: "user", content: userMessage });

              // --- Send initial AI message with loading indicator ---
              // Send an empty or "typing..." message first, then update it
              const aiMessageId = Date.now(); // Simple ID for now
              panel?.webview.postMessage({
                command: "addMessage",
                message: {
                  sender: "ai",
                  text: "",
                  id: aiMessageId,
                  streaming: true,
                }, // Mark as streaming
              });

              try {
                let currentAiResponse = "";
                const aiResponse = await callOpenRouter(
                  userMessage,
                  chatHistory,
                  (chunk: string) => {
                    currentAiResponse += chunk;
                    // Update the existing message with new chunks
                    panel?.webview.postMessage({
                      command: "updateMessage", // New command for updating
                      message: {
                        id: aiMessageId,
                        text: currentAiResponse,
                        streaming: true,
                      },
                    });
                  }
                );

                // Once streaming is complete, add the final message to history
                chatHistory.push({ role: "assistant", content: aiResponse });

                // Send a final update to mark streaming as complete
                panel?.webview.postMessage({
                  command: "updateMessage",
                  message: {
                    id: aiMessageId,
                    text: aiResponse,
                    streaming: false,
                  },
                });

                console.log("OpenRouter AI Response (Full):", aiResponse);
              } catch (error: any) {
                console.error("Error communicating with OpenRouter:", error);
                vscode.window.showErrorMessage(
                  `Error from AI: ${error.message || error}`
                );
                panel?.webview.postMessage({
                  command: "updateMessage", // Still update with error
                  message: {
                    id: aiMessageId,
                    sender: "ai",
                    text: `Error processing your request: ${
                      error.message || "Unknown error"
                    }`,
                    streaming: false,
                  },
                });
                chatHistory.pop(); // Remove user message if AI failed
              }
              return;

            case "requestContext": // New command from WebView to request context
              const editor = vscode.window.activeTextEditor;
              // console.log(vscode.window);

              if (editor) {
                const document = editor.document;
                const fullText = document.getText();
                const fileName = path.basename(document.fileName); // Get just the filename
                const contextContent = fullText.substring(
                  0,
                  Math.min(fullText.length, 500)
                );

                // Send the context back to the WebView
                panel?.webview.postMessage({
                  command: "displayContext", // Command for React to display context
                  context: {
                    fileName: fileName,
                    content: contextContent,
                  },
                });
                console.log(`Sent context for ${fileName} to WebView.`);
              } else {
                panel?.webview.postMessage({
                  command: "displayContext",
                  context: {
                    fileName: "No active editor",
                    context: {
                      fileName: "No active editor",
                      content: "No open file to get context from.",
                    },
                  },
                });
                console.log("No active editor to get context from.");
              }
              return;
          }
        },
        undefined,
        context.subscriptions
      );

      // Handle panel dispose (e.g., user closes the panel)
      panel.onDidDispose(
        () => {
          panel = undefined; // Clear reference
          chatHistory = [];
        },
        null,
        context.subscriptions
      );
    }
  );

  context.subscriptions.push(disposable);
  console.log("--- Command registered successfully ---");
}

export function deactivate() {
  // cleanup
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
  const htmlFilePath = path.join(
    extensionUri.fsPath,
    "webview-ui",
    "dist",
    "index.html"
  );

  // Read the HTML file content
  let htmlContent = fs.readFileSync(htmlFilePath, "utf8");

  // Generate a nonce for the Content Security Policy
  const nonce = getNonce();

  // Replace placeholders/adjust paths in the HTML
  // Vite generates relative paths like /assets/index-Dq-KM1J_.js
  // We need to convert them to webview-specific URIs
  // The base path for your resources within the webview
  const baseUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "webview-ui", "dist")
  );

  // Replace all relative URIs with the webview-specific URIs
  // This regex looks for src="...", href="..." attributes that start with a slash
  // and are not external (e.g., //cdn.example.com)
  htmlContent = htmlContent.replace(
    /(src|href)="\/(assets\/[^"]+\.(js|css))"/g,
    (match, attr, resourcePath) => {
      const resourceUri = vscode.Uri.joinPath(baseUri, resourcePath);
      return `${attr}="${resourceUri}"`;
    }
  );

  // Inject the CSP meta tag and nonce into script tags
  // The previous errors indicate issues with style-src, so let's check it.
  // 'unsafe-inline' is often needed for dynamic styles from React/Tailwind/styled-components.
  // But let's try to be as strict as possible first.
  const cspSource = webview.cspSource; // This is the 'vscode-webview://...' origin
  const cspMetaTag = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src <span class="math-inline">\{cspSource\} 'unsafe\-inline'; script\-src 'nonce\-</span>{nonce}';">`;
  const cleanedCspMetaTag = `
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    `;

  // Inject CSP right after the <head> tag
  htmlContent = htmlContent.replace("<head>", `<head>${cleanedCspMetaTag}`);

  // Add nonce to all script tags (Vite's generated scripts)
  htmlContent = htmlContent.replace(/<script/g, `<script nonce="${nonce}"`);

  return htmlContent;
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
