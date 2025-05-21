import dotenv from 'dotenv';
import { resolve } from 'path';
import {data} from './handle_msg/process_data.js';

dotenv.config({
  path: resolve('../..//.env')
});

const key = process.env.KEY;
const port = process.env.PORT;

export let token;

function createWebSocket(onMessageCallback) {
  const socket = new WebSocket('ws://localhost:' + port);

  socket.addEventListener('open', () => {
    console.log('WebSocket connection established!');
    // Send an auth request to the WebSocket server.
    socket.send(data({ type: "auth", key: key }));
  });

  socket.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    console.log('Message from server: ', msg);
    if (!token) {
      token = msg.token;
    } else if (msg.type === "notify") {
      onMessageCallback(msg.content); // Call the callback with the message content
    }
  });

  return {
    socket, // Return the socket for later use
    sendMessage: (message) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      } else {
        console.error('WebSocket is not open. Unable to send message.');
      }
    }
  };
}

// Export the function
export { createWebSocket };