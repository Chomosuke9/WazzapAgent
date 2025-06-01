async function sendMessage(sock, target, message, mentions) {
  sock.sendMessage(target, { text : message, mentions : mentions });
}

async function sendMessageAndGetInfo(sock, target, message, mentions) {
  return await sock.sendMessage(target, { text : message, mentions : mentions });
}

async function tagAllMembers(sock, target) {
  const participants = getGroupMembers(sock, target)
  await sendMessage(target, { text : "@everyone", mentions : participants });
}


function getGroupMembers(sock, jid) {
  const metadata = sock.groupMetadata(jid);
  return metadata.participants;

}

function getGroupAdmins(sock : Object, jid : string) : string[] {
  const metadata = sock.groupMetadata(jid);
  const admins = [];
  for (const participant of metadata.participants) {
    if (participant.isAdmin) {
      admins.push(participant.id);
    }
  }
  return admins;
}

module.exports = { getGroupMembers, getGroupAdmins, sendMessage};