/**
 * sendButtons.js — Legacy proto-based button messages.
 * (ButtonsMessage and HydratedFourRowTemplate)
 *
 * These formats may not render on newer WhatsApp clients.
 * Prefer sendInteractive.js for modern NativeFlow-based buttons.
 */
import { proto } from 'baileys';

/**
 * Send a legacy ButtonsMessage (may not render on newer WhatsApp versions).
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {string} body - Message body text
 * @param {Array<{id: string, displayText: string}>} buttons - Button definitions (max 3)
 * @param {{footer?: string, title?: string, quoted?: object}} [options]
 * @returns {Promise<object>}
 * @example
 * await sendLegacyButtons(sock, jid, 'Pilih:', [
 *   { id: 'btn1', displayText: 'Opsi 1' },
 *   { id: 'btn2', displayText: 'Opsi 2' }
 * ], { footer: 'Tap to choose' });
 */
async function sendLegacyButtons(sock, jid, body, buttons, options = {}) {
  return sock.sendMessage(jid, {
    buttonsMessage: proto.Message.ButtonsMessage.fromObject({
      contentText: body,
      footerText: options.footer || '',
      headerType: 1,
      buttons: buttons.map((btn) => ({
        buttonId: btn.id,
        buttonText: { displayText: btn.displayText },
        type: 1,
      })),
    }),
  }, { quoted: options.quoted });
}

/**
 * Send a HydratedFourRowTemplate (TemplateMessage) with mixed button types.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {string} body - Message body text
 * @param {Array<
 *   {index: number, quickReplyButton: {id: string, displayText: string}} |
 *   {index: number, urlButton: {displayText: string, url: string}} |
 *   {index: number, callButton: {displayText: string, phoneNumber: string}}
 * >} buttons
 * @param {{footer?: string, title?: string, quoted?: object}} [options]
 * @returns {Promise<object>}
 * @example
 * await sendTemplate(sock, jid, 'Selamat datang!', [
 *   { index: 1, quickReplyButton: { id: 'start', displayText: 'Mulai' } },
 *   { index: 2, urlButton: { displayText: 'Website', url: 'https://example.com' } }
 * ], { title: 'Halo!', footer: 'Tim Support' });
 */
async function sendTemplate(sock, jid, body, buttons, options = {}) {
  return sock.sendMessage(jid, {
    templateMessage: proto.Message.TemplateMessage.fromObject({
      hydratedTemplate: {
        hydratedContentText: body,
        hydratedFooterText: options.footer || '',
        hydratedTitleText: options.title || '',
        hydratedButtons: buttons.map((btn) => {
          if (btn.quickReplyButton) {
            return {
              index: btn.index,
              quickReplyButton: {
                displayText: btn.quickReplyButton.displayText,
                id: btn.quickReplyButton.id,
              },
            };
          }
          if (btn.urlButton) {
            return {
              index: btn.index,
              urlButton: {
                displayText: btn.urlButton.displayText,
                url: btn.urlButton.url,
              },
            };
          }
          if (btn.callButton) {
            return {
              index: btn.index,
              callButton: {
                displayText: btn.callButton.displayText,
                phoneNumber: btn.callButton.phoneNumber,
              },
            };
          }
          return btn;
        }),
      },
    }),
  }, { quoted: options.quoted });
}

export { sendLegacyButtons, sendTemplate };
