require('dotenv').config({
  path: require('path').resolve(__dirname, '../../../.env')
});

const data = require("./process_data");

const key = process.env.KEY;
const port = process.env.PORT;
let token;


const socket = new WebSocket('ws://localhost:' + port);


// Executes when the connection is successfully established.
socket.addEventListener('open', () => {
  console.log('WebSocket connection established!');
  // Send an auth request to the WebSocket server.
  socket.send(data.data({type : "auth", key : key}));

});

// Listen for messages and executes when a message is received from the server.
socket.addEventListener('message', event => {
  const msg = JSON.parse(event.data);
  console.log('Message from server: ', msg);
  if (!token){
    token = msg.token;
    //socket.send(data.data({token, type : "notify", content :"test"}));
  }
  else if (msg.type === "notify") {
   console.log(msg.content);
}});