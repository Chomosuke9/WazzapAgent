import '../whatsapp_bot/utils/functions.js'
import {sendMessage} from "../whatsapp_bot/utils/functions.js";



function handle_message(sock,msg) {
	if (msg.type === "chat"){
		sendMessage(sock, {message : msg.content})
	}
}