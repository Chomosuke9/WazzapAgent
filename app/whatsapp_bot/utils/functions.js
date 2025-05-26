/**
 * @param  {SendMessageOptions} options
 */
async function sendMessage(options) {
  const { sock, target, message, image,video, mentions, sendAsReply} = options;
  await sock.sendMessage(target, { text: message, mentions : mentions, quotedMsg: sendAsReply, image : image, video : video});
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