def parse_whatsapp_message(message_data: dict) -> dict | None:
    """
    Parse WhatsApp message data and extract key information

    Args:
        message_data (dict): WhatsApp message data

    Returns:
        dict: Dictionaries with extracted message information
    """
    try:
        if not isinstance(message_data, dict):
            print("Unrecognized message format")
            return None

        messages = message_data.get('content', {}).get('messages', [])
        if not messages:
            print("Unrecognized message format")
            return None

        # Take the first message only
        msg = messages[0]
        key = msg.get('key', {})
        message_obj = msg.get('message', {})

        parsed_msg = {
            'type': 'Unknown',
            'remoteJid': key.get('remoteJid', ''),
            'participant': key.get('participant', ''),
            'id': key.get('id', ''),
            'timestamp': str(msg.get('messageTimestamp', 0)),
            'pushName': msg.get('pushName', ''),
            'message': '',
            'media': None,
            'quotedMessage': None,
            'quotedParticipant': None,
            'mentions': []
        }

        # Handle text message (extendedTextMessage)
        if 'extendedTextMessage' in message_obj:
            ext = message_obj['extendedTextMessage']
            parsed_msg['type'] = 'text'
            parsed_msg['message'] = ext.get('text', '')

            ctx = ext.get('contextInfo', {})
            if ctx:
                parsed_msg['mentions'] = ctx.get('mentionedJid', [])
                quoted = ctx.get('quotedMessage', {})
                if quoted:
                    parsed_msg['quotedMessage'] = quoted.get('conversation', '')
                    parsed_msg['quotedParticipant'] = ctx.get('participant', '')

        # Handle normal text message (conversation)
        elif 'conversation' in message_obj:
            parsed_msg['type'] = 'text'
            parsed_msg['message'] = message_obj['conversation']

        # Handle media message (if any)
        media_types = (
            'imageMessage', 'videoMessage', 'audioMessage',
            'documentMessage', 'documentWithCaptionMessage', 'stickerMessage'
        )
        media_type = next((mt for mt in media_types if mt in message_obj), None)
        if media_type:
            media_msg = message_obj[media_type]
            parsed_msg['media'] = {
                'type': media_type[:-7],  # remove 'Message' from type name
                'mimetype': media_msg.get('mimetype', ''),
                'fileLength': media_msg.get('fileLength', ''),
                'fileName': media_msg.get('fileName', '')
            }
            # Use caption as message if there is no text
            parsed_msg['message'] = media_msg.get('caption', '')

        return parsed_msg

    except Exception as e:
        print(f"Error parsing message: {e}")
        return None

