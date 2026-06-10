/**
 * sendButtons.js — Legacy proto-based button messages.
 * (ButtonsMessage and HydratedFourRowTemplate)
 *
 * These formats may not render on newer WhatsApp clients.
 * Prefer sendInteractive.js for modern NativeFlow-based buttons.
 */
import { proto } from 'baileys';
import type { AnyMessageContent, WAMessage, WASocket } from 'baileys';

type LegacyOptions = {
  footer?: string;
  title?: string;
  quoted?: WAMessage;
};

type LegacyButton = {
  id: string;
  displayText: string;
};

type TemplateButton =
  | { index: number; quickReplyButton: { id: string; displayText: string }; urlButton?: never; callButton?: never }
  | { index: number; urlButton: { displayText: string; url: string }; quickReplyButton?: never; callButton?: never }
  | { index: number; callButton: { displayText: string; phoneNumber: string }; quickReplyButton?: never; urlButton?: never };

/**
 * Send a legacy ButtonsMessage (may not render on newer WhatsApp versions).
 *
 * @example
 * await sendLegacyButtons(sock, jid, 'Pilih:', [
 *   { id: 'btn1', displayText: 'Opsi 1' },
 *   { id: 'btn2', displayText: 'Opsi 2' }
 * ], { footer: 'Tap to choose' });
 */
async function sendLegacyButtons(
  sock: WASocket,
  jid: string,
  body: string,
  buttons: LegacyButton[],
  options: LegacyOptions = {},
): Promise<WAMessage | undefined> {
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
  } as unknown as AnyMessageContent, { quoted: options.quoted });
}

/**
 * Send a HydratedFourRowTemplate (TemplateMessage) with mixed button types.
 *
 * @example
 * await sendTemplate(sock, jid, 'Selamat datang!', [
 *   { index: 1, quickReplyButton: { id: 'start', displayText: 'Mulai' } },
 *   { index: 2, urlButton: { displayText: 'Website', url: 'https://example.com' } }
 * ], { title: 'Halo!', footer: 'Tim Support' });
 */
async function sendTemplate(
  sock: WASocket,
  jid: string,
  body: string,
  buttons: TemplateButton[],
  options: LegacyOptions = {},
): Promise<WAMessage | undefined> {
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
  } as unknown as AnyMessageContent, { quoted: options.quoted });
}

export { sendLegacyButtons, sendTemplate };
