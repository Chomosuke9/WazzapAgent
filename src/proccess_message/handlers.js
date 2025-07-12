import * as chat from "../whatsapp_bot/utils/functions.js"
import {feedback} from "../bridge/javascript/handle_msg/process_data.js";
import {token} from "../bridge/javascript/client.js";


async function handleMessage(WASocket, WebSocket, msg){
	//console.log(msg)
	if (msg.type === "simpleChat"){
		await chat.sendMessageToTarget(WASocket,msg.target, msg.message, msg.mentions)

	} else if (msg.type === "editMessage"){
		await chat.editMessage(WASocket, msg.message, msg.key)

	} else if (msg.type === "tagEveryone"){
		await chat.tagAllMembers(WASocket, msg.target)
		console.log("tagging all members from ", msg.target)

	} else if (msg.type === "chatAndGetInfo"){
		const result = await chat.sendMessageAndGetInfo(WASocket, msg.target, msg.message, msg.mentions)
		WebSocket.send(feedback(token, result, msg.uid))

	} else if (msg.type === "sendButton"){
		await chat.sendButtonMessage(WASocket, msg.target, msg.quoted)
	}
}

export {handleMessage}