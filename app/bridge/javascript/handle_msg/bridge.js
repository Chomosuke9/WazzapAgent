import {startWABot} from "../../../whatsapp_bot/bot/bot.js"
import {WebSocketClient} from "../client.js"


const sock = new WebSocketClient(handleServerMessage())

async function handleServerMessage(messageFromServer) {
    console.log(messageFromServer)
}


startWABot(async (messageFromWA) => {
    console.log(messageFromWA)
})
