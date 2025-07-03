import '../whatsapp_bot/utils/functions.js'
import {
	sendMessageToTarget,
	tagAllMembers,
	sendMessageAndGetInfo,
	editMessage
} from "../whatsapp_bot/utils/functions.js"
import {feedback} from "../bridge/javascript/handle_msg/process_data.js";
import {token} from "../bridge/javascript/client.js";


async function handle_message(WASocket, WebSocket, msg){
	console.log(msg)
	if (msg.type === "simpleChat"){
		await sendMessageToTarget(WASocket,msg.target, msg.message, msg.mentions)
	}else if (msg.type === "editMessage"){
		await editMessage(WASocket, msg.message, msg.key)
	} else if (msg.type === "tagEveryone"){
		await tagAllMembers(WASocket, msg.target)
		console.log("tagging all members from ", msg.target)
	} else if (msg.type === "chatAndGetInfo"){
		const result = await sendMessageAndGetInfo(WASocket, msg.target, msg.message, msg.mentions)
		WebSocket.send(feedback(token, result, msg.uid))

	}
}

export {handle_message}