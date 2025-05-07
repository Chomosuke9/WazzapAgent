import dotenv from 'dotenv';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, '../../../.env')
});

const data = import("./handle_msg/process_data.js");

const key = process.env.KEY;
const port = process.env.PORT;
let token;

class WebSocketClient {
    constructor(msgFromServer) {
        this.socket = new WebSocket('ws://localhost:' + port);

        // Executes when the connection is successfully established.
        this.socket.addEventListener('open', () => {
            console.log('WebSocket connection established!');
            // Send an auth request to the WebSocket server.
            this.sendToServer({type: "auth", key: key});
        });

        // Listen for messages and send to handler when a message is received from the server.
        this.socket.addEventListener('message', event => {
                  const msg = JSON.parse(event.data);
                  if (msg?.type === "auth") {
                      if (msg?.status === "success") {
                          console.log("Auth success")
                          token = msg.token
                      } else {
                          console.log("Auth failed... Key : " + key)
                      }
                  } else if (msg?.type === "chat" || msg?.type === "notify") {
                      return msgFromServer(msg);
                  }

              }
        );
    }

    async sendToServer(content) {
        content.token = token
        const contentJSON = JSON.stringify(content);
        this.socket.send(contentJSON);
    }
}

export {WebSocketClient};

