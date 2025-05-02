import json
from groq import Groq

# API Key Groq
api_key = "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"

test = input("Masukkan pertanyaan: ")

# Definisi fungsi yang bisa dipanggil oleh model
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_current_weather",
            "description": "Get the current weather in a given location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "The city and state, e.g. San Francisco, CA"
                    },
                    "unit": {
                        "type": "string",
                        "enum": ["celsius", "fahrenheit"]
                    }
                },
                "required": ["location"]
            }
        }
    }
]

# Handler fungsi lokal (yang akan dipanggil ketika model minta tool)
def get_current_weather(location, unit="celsius"):
    # Kamu bisa ganti bagian ini dengan API cuaca sungguhan
    return {
        "location": location,
        "temperature": "22",
        "unit": unit,
        "description": "Sunny"
    }

# Inisialisasi klien Groq
client = Groq(api_key=api_key)

# Kirim permintaan awal
initial_response = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[
        {
            "role": "user",
            "content": test
        }
    ],
    tools=tools,
    tool_choice="auto",
    temperature=0.7,
    max_tokens=1024,
)

# Ambil tool_call dari respon jika ada
tool_calls = initial_response.choices[0].message.tool_calls

if tool_calls:
    # Kita hanya pakai tool pertama
    tool_call = tool_calls[0]
    function_name = tool_call.function.name
    arguments = json.loads(tool_call.function.arguments)
    tool_call_id = tool_call.id

    # Jalankan fungsi lokal berdasarkan nama
    if function_name == "get_current_weather":
        result = get_current_weather(**arguments)

    # Kirim hasil tool ke model sebagai message baru
    final_response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {
                "role": "user",
                "content": test
            },
            {
                "role": "assistant",
                "tool_calls": [tool_call.model_dump()]
            },
            {
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": json.dumps(result)
            }
        ],
        tools=tools,

    )

    # Tampilkan hasil akhirnya
    print("\n🟢 Final Response:")
    print(final_response.choices[0].message.content)

else:
    print("\n⚠️ Model tidak memanggil tool.")
    print(initial_response.choices[0].message.content)
