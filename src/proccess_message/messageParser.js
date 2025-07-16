/**
 * Helper to parse a simple vCard from a contact message.
 * @param {string} vcard - The vCard string.
 * @returns {object} Object containing the name and phone number.
 */
function parseVCard(vcard) {
    if (!vcard) return { name: null, phone: null };
    const nameMatch = vcard.match(/FN:(.*)/);
    const telMatch = vcard.match(/waid=(\d+):([+\d\s-]+)/);
    return {
        name: nameMatch ? nameMatch[1].trim() : null,
        phone: telMatch ? telMatch[2].trim() : null,
    };
}

/**
 * Main function to parse a single message log entry into the desired format.
 * @param {object} logEntry - A single message object from the log file.
 * @param {boolean} isQuoted - Internal flag to indicate a recursive call for a quoted message.
 * @returns {object|null} The parsed JSON object or null if invalid.
 */
function parseMessage(logEntry, isQuoted = false) {
    if (!logEntry) return null;

    // Determine the main data source, as the structure can differ for main vs. quoted messages
    const key = logEntry.key || { id: logEntry.stanzaId };
    const participant = logEntry.key?.participant || logEntry.participant;
    const messageData = logEntry.message || logEntry;

    if (!key || !messageData) return null;
    
    // Look for contextInfo in various possible locations
    const contextInfo = messageData.extendedTextMessage?.contextInfo ||
                        messageData.buttonsResponseMessage?.contextInfo ||
                        messageData.interactiveResponseMessage?.contextInfo ||
                        messageData.contextInfo;

    // Initialize the output structure
    const output = {
        type: '',
        remoteJid: logEntry.key?.remoteJid,
        participant: participant,
        fromMe: logEntry.key?.fromMe,
        id: key.id,
        timestamp: logEntry.messageTimestamp,
        pushName: logEntry.pushName,
        verifiedBizName: logEntry.verifiedBizName || null,
        isForwarded: !!contextInfo?.isForwarded,
        message: null,
        mediaType: null,
        quotedMessage: null,
        mentions: [],
        details: null,
    };

    // Process the quoted message recursively if it exists
    if (!isQuoted && contextInfo?.quotedMessage) {
        const quotedLogEntry = {
            ...contextInfo.quotedMessage,
            participant: contextInfo.participant,
            stanzaId: contextInfo.stanzaId,
        };
        output.quotedMessage = parseMessage(quotedLogEntry, true);
    }
    
    if (contextInfo?.mentionedJid) {
        output.mentions = contextInfo.mentionedJid;
    }

    // --- Handling Logic for Various Message Types ---
    if (messageData.conversation) {
        output.type = 'text';
        output.message = messageData.conversation;
    } else if (messageData.extendedTextMessage) {
        output.type = 'text';
        output.message = messageData.extendedTextMessage.text;
    } else if (messageData.imageMessage) {
        output.type = 'media';
        output.message = messageData.imageMessage.caption || null;
        output.mediaType = 'image';
    } else if (messageData.videoMessage) {
        output.type = 'media';
        output.message = messageData.videoMessage.caption || null;
        output.mediaType = 'video';
    } else if (messageData.audioMessage) {
        output.type = 'media';
        output.mediaType = 'audio';
        output.details = { isPtt: messageData.audioMessage.ptt, seconds: messageData.audioMessage.seconds };
    } else if (messageData.documentMessage) {
        output.type = 'media';
        output.mediaType = 'document';
        output.message = messageData.documentMessage.caption || null;
        output.details = { fileName: messageData.documentMessage.fileName };
    } else if (messageData.stickerMessage || messageData.lottieStickerMessage) {
        const stickerData = messageData.stickerMessage || messageData.lottieStickerMessage.message.stickerMessage;
        output.type = 'media';
        output.mediaType = 'sticker';
        output.details = { 
            isAnimated: !!stickerData.isAnimated,
            isAvatar: !!stickerData.isAvatar 
        };
    } else if (messageData.reactionMessage || messageData.encReactionMessage) {
        output.type = 'reaction';
        // For encrypted reactions, we cannot see the emoji
        output.details = {
            emoji: messageData.reactionMessage?.text || '[encrypted]',
            targetMessageId: messageData.reactionMessage?.key.id || messageData.encReactionMessage?.targetMessageKey.id,
        };
    } else if (messageData.pollCreationMessageV3) {
        output.type = 'poll_creation';
        output.details = {
            question: messageData.pollCreationMessageV3.name,
            options: messageData.pollCreationMessageV3.options.map(opt => opt.optionName)
        };
    } else if (messageData.pollUpdateMessage) {
        output.type = 'poll_update';
        output.details = {
            targetPollId: messageData.pollUpdateMessage.pollCreationMessageKey.id
        }
    } else if (messageData.contactMessage) {
        output.type = 'contact';
        output.details = parseVCard(messageData.contactMessage.vcard);
    } else if (messageData.protocolMessage) {
        if (messageData.protocolMessage.type === 'MESSAGE_EDIT') {
            output.type = 'message_edit';
            output.id = messageData.protocolMessage.key.id; // Use the ID of the edited message
            output.details = {
                newMessage: messageData.protocolMessage.editedMessage.conversation,
            };
        }
    } else if (messageData.buttonsResponseMessage) {
        output.type = 'interactive_response';
        output.message = messageData.buttonsResponseMessage.selectedDisplayText;
        output.details = {
            selectedButtonId: messageData.buttonsResponseMessage.selectedButtonId
        };
    } else if (messageData.interactiveResponseMessage) {
        output.type = 'interactive_response';
        output.message = messageData.interactiveResponseMessage.body?.text || null;
        output.details = {
            paramsJson: messageData.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson
        };
    } else {
        const keys = Object.keys(messageData);
        output.type = keys.find(k => k.toLowerCase().includes('message')) || keys[0] || 'unknown';
    }
    console.log("Parsed message:", output);
    return output;
}

// Export the main function so it can be used in other files
export { parseMessage };