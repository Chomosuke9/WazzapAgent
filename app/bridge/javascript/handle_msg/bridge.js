import {startWASocket} from "../../../whatsapp_bot/bot/bot.js"
import {token, createWebSocket} from "../client.js"
import {data} from "./process_data.js";


const { socket} = createWebSocket((msg) => {
  console.log('Received notification: ', msg);
});

const WASocket = startWASocket()

WASocket.getSocket().ev.on("messages.upsert", async (msg) => {
    socket.send(data({token : token, type : "chat", content : msg}))
})
