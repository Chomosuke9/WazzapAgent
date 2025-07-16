import { port, key } from '../../state/state.js';
import {auth} from './handle_msg/process_data.js';

export let token;

function createWebSocket(onMessageCallback) {
  const socket = new WebSocket('ws://localhost:' + port);

  socket.addEventListener('open', () => {
    console.log('WebSocket connection established!');
    // Send an auth request to the WebSocket server.
    socket.send(auth(key))
  });

  socket.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    //console.log('Message from server: ' , msg);
    if (token) {onMessageCallback(msg)}
    else if (!token || msg.type === "auth") {token = msg.token; onMessageCallback(msg)}
  });

  return  socket  // Return the socket for later use;
}

// Export the function
export { createWebSocket };