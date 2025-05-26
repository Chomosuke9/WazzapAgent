import requests

API_KEY = 'YOUR_API_KEY'  # Ganti dengan API key kamu
QUERY = 'openai chatgpt'
URL = 'https://api.search.brave.com/res/v1/web/search'

headers = {
    'Authorization': f'Bearer {API_KEY}',
    'Accept': 'application/json'
}

params = {
    'q': QUERY,
    'count': 5,  # jumlah hasil yang ingin ditampilkan
}

response = requests.get(URL, headers=headers, params=params)

if response.status_code == 200:
    data = response.json()
    results = data.get("web", {}).get("results", [])
    for i, result in enumerate(results, 1):
        print(f"{i}. {result['title']}")
        print(f"   {result['url']}")
        print(f"   {result['description']}\n")
else:
    print("Gagal mengambil data:", response.status_code, response.text)
