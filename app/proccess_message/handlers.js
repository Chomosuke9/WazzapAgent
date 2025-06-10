import '../whatsapp_bot/utils/functions.js'
import {
	sendMessageToTarget,
	tagAllMembers,
	sendMessageAndGetInfo,
	editMessage
} from "../whatsapp_bot/utils/functions.js"
import {socket} from "../bridge/javascript/handle_msg/bridge.js";
import {feedback} from "../bridge/javascript/handle_msg/process_data.js";
import {token} from "../bridge/javascript/client.js";


async function handle_message(sock,msg){
	console.log(msg)
	if (msg.type === "simpleChat"){
		await sendMessageToTarget(sock,msg.target, msg.message, msg.mentions)
	}else if (msg.type === "editMessage"){
		await editMessage(sock, msg.message, msg.key)
	} else if (msg.type === "tagEveryone"){
		await tagAllMembers(sock, msg.target)
		console.log("tagging all members from ", msg.target)
	} else if (msg.type === "chatAndGetInfo"){
		const result = await sendMessageAndGetInfo(sock, msg.target, msg.message, msg.mentions)
		socket.send(feedback(token, result, msg.uid))

	}
}

export {handle_message}