import json


def parse_whatsapp_message(message_data: dict) -> list | None:
    """
      Parse WhatsApp message data and extract key information

      Args:
          message_data (dict): WhatsApp message data

      Returns:
          list: List of dictionaries with extracted message information
      """
    try:
        # Check if message_data has the expected structure
        if not isinstance(message_data, dict) or 'content' not in message_data:
            print("Unrecognized message format")
            return None

        content = message_data.get('content', {})
        messages = content.get('messages', [])

        if not messages:
            print("Unrecognized message format")
            return None

        parsed_messages = []

        for msg in messages:
            try:
                # Extract basic information
                key = msg.get('key', {})
                remote_jid = key.get('remoteJid', '')
                participant = key.get('participant', '')  # Only present in group messages
                message_id = key.get('id', '')
                timestamp = msg.get('messageTimestamp', 0)
                push_name = msg.get('pushName', '')

                # Extract message content
                message_obj = msg.get('message', {})

                # Initialize variables
                message_type = ...
                text_message = ''
                media_info = None
                quoted_message = None
                quoted_participant = None
                caption = ''
                mentions = []

                if 'extendedTextMessage' in message_obj or 'conversation' in message_obj:
                    message_type = 'text'
                    extended_msg = message_obj.get('extendedTextMessage') or None
                    text_message = extended_msg.get('text', '') or message_obj.get('conversation', '')

                    if extended_msg:
                        # Check for mentions
                        context_info = extended_msg.get('contextInfo', {})
                        mentions = context_info.get('mentionedJid', [])

                        # Check for quoted message
                        if 'quotedMessage' in context_info:
                            quoted_message = (context_info.get('quotedMessage', {})).get('conversation', {})

                        # Check for quoted participant
                        if 'participant' in context_info:
                            quoted_participant = context_info.get('participant', '')


                else :
                    message_type = 'Undefined'

                # Check for media messages
                media_types = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage']
                for media_type in media_types:
                    if media_type in message_obj:
                        media_msg = message_obj[media_type]
                        media_info = {
                            'type': media_type.replace('Message', ''),
                            'url': media_msg.get('url', ''),
                            'mimetype': media_msg.get('mimetype', ''),
                            'fileLength': media_msg.get('fileLength', ''),
                            'fileName': media_msg.get('fileName', '')
                        }

                        # Extract caption if present
                        caption = media_msg.get('caption', '')
                        break

                # Create simplified dictionary
                parsed_msg = {
                    'type': message_type,
                    'remoteJid': remote_jid,
                    'participant': participant,
                    'id': message_id,
                    'timestamp': str(timestamp),
                    'pushName': push_name,
                    'message': text_message or caption,
                    'media': media_info,
                    'quotedMessage': quoted_message,
                    'quotedParticipant': quoted_participant,
                    'mentions': mentions
                }

                parsed_messages.append(parsed_msg)

            except Exception as e:
                print(f"Error parsing individual message: {e}")
                continue

        return parsed_messages if parsed_messages else None

    except Exception as e:
        print("Unrecognized message format")
        return None


def process_realtime_message(raw_message):
    """
      Process a single real-time WhatsApp message

      Args:
          raw_message (dict): Raw WhatsApp message data

      Returns:
          list or None: Parsed message data or None if unrecognized
      """
    result = parse_whatsapp_message(raw_message)

    if result:
        print(f"Parsed {len(result)} message(s)")
        for msg in result:
            print(f"From: {msg['pushName']} | Message: {msg['message'][:50]}...")

    return result




async def handle_message(message):
    print(message)
    if message.get("type") == "chat":
        data = parse_whatsapp_message(message)
        print(json.dumps(data, indent=2, ensure_ascii=False))
        # TODO: handle message