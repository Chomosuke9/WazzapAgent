import * as fs from "node:fs";

export async function sendMessageToTarget(sock, target, message, mentions) {
  await sock.sendMessage(target, { text : message, mentions : mentions });

}

export async function sendMessageAndGetInfo(sock, target, message, mentions) {
  return await sock.sendMessage(target, { text : message, mentions : mentions });
}

export async function tagAllMembers(sock, target) {
  const participants = await getGroupMembers(sock, target)
  await sendMessageToTarget(sock, target, "@everyone", participants );
}


export async function getGroupMembers(sock, jid) {
  const metadata = await sock.groupMetadata(jid).then((result) => result);
  const participants = metadata.participants
  return participants.map(item => item.id)
}

export async function getGroupAdmins(sock, jid) {
  const metadata = await sock.groupMetadata(jid);
  const admins = [];
  for (const participant of metadata.participants) {
    if (participant.admin !== null) {
      admins.push(participant.id);
    }
  }
  return admins;
}

export async function editMessage(sock, message, key) {
  await sock.sendMessage(key.remoteJid, { text: message, edit: key });
}

export async function sendButtonMessage(sock, target, Qmsg, ...buttons) {


  sock.sendMessage(target, {
        text: `click, button, list`,
        footer: `Ini footer`,
        buttons: [
          {
            buttonId: 'Jawa Jawa Jawa',
            buttonText: {
              displayText: 'Ini tombol'
            },
            type: 1,
          },
          {
            buttonId: 'tag everyone',
            buttonText: {
              displayText: 'tag everyone'
            },
            type: 1,
          },
          {
            buttonId: 'action',
            buttonText: {
              displayText: 'ini pesan interactiveMeta'
            },
            type: 4,
            nativeFlowInfo: {
              name: 'single_select',
              paramsJson: JSON.stringify({
                title: 'List',
                sections: [
                  {
                    title: 'Jawa',
                    highlight_label: 'Populer',
                    rows: [
                      {
                        header: 'Test',
                        title: 'test1',
                        description: '',
                        id: 'awokawok',
                      },
                      {
                        header: 'Test',
                        title: 'test2',
                        description: '',
                        id: 'test2',
                      },
                      {
                        header: 'Test',
                        title: 'test3',
                        description: '',
                        id: 'test3',
                      }
                    ]
                  }
                ]
              })
            }
          }
        ],
        headerType: 1,
        viewOnce: true
      },
  );

}
