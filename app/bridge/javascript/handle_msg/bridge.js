import {startWASocket} from "../../../whatsapp_bot/bot/bot.js"
import {createWebSocket} from "../client.js"
import {data} from "./process_data.js";


const { socket, sendMessage } = createWebSocket((messageContent) => {
  console.log('Received notification: ', messageContent);
});


const WASocket = startWASocket()

WASocket.getSocket().ev.on("messages.upsert", async (msg) => {
    socket.send(data({type : "chat", content : msg}))
})
