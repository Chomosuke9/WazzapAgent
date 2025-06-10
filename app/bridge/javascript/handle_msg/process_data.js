function notify(token, content) {
  return JSON.stringify({
    token,
    type: "notify",
    content
  });
}

function auth(key) {
  return JSON.stringify({
    type: "auth",
    key
  });
}

function chat(token, content) {
  return JSON.stringify({
    token,
    type: "chat",
    content
  });
}

function feedback(token, content, id) {
  return JSON.stringify({
    token,
    type: "feedback",
    id,
    content
  });
}

export { notify, auth, chat, feedback };