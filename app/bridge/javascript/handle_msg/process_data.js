function data({token=null, type=null, key = null, content = null, message = null, id = null, name = null, messageType = null, mention = null}) {
  let data = null;
  if (type === "notify") {
    data = {
      token,
      type : "notify",
      content : content
    }
    return (JSON.stringify(data));
  }
  if (type === "auth") {
    data = {
      type : "auth",
      key : key,
  }
  return (JSON.stringify(data));
  }
  if (type === "chat") {
    data = {
      token,
      type : "chat",
      message : message,
      id : id,
      name : name,
      messageType : messageType,
      mention: mention,
    }
    return data
  }
  else {
    throw new Error("Invalid data type");
  }
}



export {data};