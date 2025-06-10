async function sendMessageToTarget(sock, target, message, mentions) {
  sock.sendMessage(target, { text : message, mentions : mentions });

}

async function sendMessageAndGetInfo(sock, target, message, mentions) {
  return await sock.sendMessage(target, { text : message, mentions : mentions });
}

async function tagAllMembers(sock, target) {
  const participants = await getGroupMembers(sock, target)
  await sendMessageToTarget(sock, target, "@everyone", participants );
}


async function getGroupMembers(sock, jid) {
  const metadata = await sock.groupMetadata(jid).then((result) => result);
  const participants = metadata.participants
  return participants.map(item => item.id)
}

async function getGroupAdmins(sock, jid) {
  const metadata = await sock.groupMetadata(jid);
  const admins = [];
  for (const participant of metadata.participants) {
    if (participant.isAdmin) {
      admins.push(participant.id);
    }
  }
  return admins;
}

async function editMessage(sock, message, key) {
  sock.sendMessage(key.remoteJid, { text: message, edit: key });
}

export { sendMessageToTarget, sendMessageAndGetInfo, tagAllMembers, getGroupMembers, getGroupAdmins, editMessage };