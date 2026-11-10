const $ = id => document.getElementById(id);
let token = localStorage.getItem("chatspace_token");
let me = null, socket = null, selectedUser = null, users = [], onlineIds = new Set();
let pc = null, localStream = null, currentCallPeer = null, incomingCall = false;
const unreadCounts = {};
let notificationsEnabled = localStorage.getItem("chatspace_notifications") === "on";
let authMode = "login";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2600);
}
async function api(url, options = {}) {
  const headers = options.headers || {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function setAuthMode(mode) {
  authMode = mode;
  $("loginTab").classList.toggle("active", mode === "login");
  $("signupTab").classList.toggle("active", mode === "signup");
  $("nameLabel").classList.toggle("hidden", mode !== "signup");
  $("authSubmit").textContent = mode === "login" ? "Log in" : "Create account";
  $("passwordInput").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("authError").textContent = "";
}
$("loginTab").onclick = () => setAuthMode("login");
$("signupTab").onclick = () => setAuthMode("signup");
$("authForm").onsubmit = async e => {
  e.preventDefault();
  $("authError").textContent = "";
  try {
    const body = { email: $("emailInput").value, password: $("passwordInput").value };
    if (authMode === "signup") body.name = $("nameInput").value.trim();
    const data = await api(`/api/auth/${authMode === "login" ? "login" : "signup"}`, {
      method: "POST", body: JSON.stringify(body)
    });
    token = data.token; me = data.user;
    localStorage.setItem("chatspace_token", token);
    await startApp();
  } catch (err) { $("authError").textContent = err.message; }
};
$("logoutBtn").onclick = logout;
async function logout() {
  if (socket) socket.disconnect();
  await cleanupCall();
  localStorage.removeItem("chatspace_token");
  token = null; me = null; selectedUser = null;
  $("app").classList.add("hidden"); $("authScreen").classList.remove("hidden");
}
async function startApp() {
  try {
    if (!me) me = (await api("/api/me")).user;
    $("authScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("myName").textContent = me.name;
    $("myAvatar").textContent = initials(me.name);
    await loadUsers();
    updateNotificationButton();
    connectSocket();
  } catch (err) {
    localStorage.removeItem("chatspace_token"); token = null;
    $("authScreen").classList.remove("hidden");
    $("app").classList.add("hidden");
    $("authError").textContent = "Please log in again.";
  }
}
function initials(name) { return (name || "?").trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase(); }
async function loadUsers(query = "") {
  const data = await api(`/api/users?q=${encodeURIComponent(query)}`);
  users = data.users;
  renderUsers();
}
function renderUsers() {
  $("peopleCount").textContent = users.length;
  $("peopleList").innerHTML = "";
  users.forEach(user => {
    const row = document.createElement("div");
    row.className = "person" + (selectedUser?.id === user.id ? " active" : "");
    const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = initials(user.name);
    const copy = document.createElement("div"); copy.className = "person-copy";
    const name = document.createElement("strong"); name.textContent = user.name;
    const unread = unreadCounts[user.id] || 0;
    if (unread) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      name.appendChild(badge);
    }
    const detail = document.createElement("small"); detail.textContent = onlineIds.has(user.id) ? "Online now" : user.email;
    copy.append(name, detail);
    const meta = document.createElement("span"); meta.className = "person-meta"; meta.textContent = onlineIds.has(user.id) ? "●" : "";
    row.append(avatar, copy, meta);
    row.onclick = () => openConversation(user);
    $("peopleList").appendChild(row);
  });
}
$("searchInput").addEventListener("input", e => {
  clearTimeout(window.searchTimer);
  window.searchTimer = setTimeout(() => loadUsers(e.target.value).catch(err=>toast(err.message)), 220);
});
async function openConversation(user) {
  selectedUser = user;
  unreadCounts[user.id] = 0;
  renderUsers();
  $("emptyState").classList.add("hidden"); $("chatPanel").classList.remove("hidden");
  $("chatName").textContent = user.name;
  $("chatAvatar").textContent = initials(user.name);
  updateChatStatus();
  renderUsers();
  $("messages").innerHTML = "";
  try {
    const data = await api(`/api/messages/${user.id}`);
    data.messages.forEach(addMessage);
    scrollMessages();
  } catch (err) { toast(err.message); }
}
function updateChatStatus() {
  if (!selectedUser) return;
  const online = onlineIds.has(selectedUser.id);
  $("chatStatus").textContent = online ? "● Online" : "Offline";
  $("chatStatus").classList.toggle("online", online);
}
function addMessage(message) {
  if (!selectedUser) return;
  const relevant = (message.sender === me.id && message.recipient === selectedUser.id) ||
    (message.sender === selectedUser.id && message.recipient === me.id);
  if (!relevant) return;
  const bubble = document.createElement("div");
  bubble.className = "bubble" + (message.sender === me.id ? " mine" : "");
  if (message.imageUrl) {
    const img = document.createElement("img");
    img.src = message.imageUrl; img.alt = "Shared image"; img.loading = "lazy";
    img.onclick = () => window.open(message.imageUrl, "_blank", "noopener");
    bubble.appendChild(img);
  }
  if (message.text) {
    const text = document.createElement("div"); text.textContent = message.text; bubble.appendChild(text);
  }
  const time = document.createElement("span"); time.className = "bubble-time";
  time.textContent = new Date(message.createdAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  bubble.appendChild(time);
  $("messages").appendChild(bubble);
  scrollMessages();
}
function scrollMessages() { $("messages").scrollTop = $("messages").scrollHeight; }
function sendText() {
  const text = $("messageInput").value.trim();
  if (!text || !selectedUser || !socket) return;
  socket.emit("private:message", { recipient: selectedUser.id, text });
  $("messageInput").value = "";
}
$("sendBtn").onclick = sendText;
$("messageInput").addEventListener("keydown", e => { if (e.key === "Enter") sendText(); });
$("attachBtn").onclick = () => $("imageInput").click();
$("imageInput").onchange = async e => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file || !selectedUser) return;
  if (file.size > 5 * 1024 * 1024) return toast("Image must be 5 MB or smaller");
  const form = new FormData(); form.append("image", file);
  try {
    const data = await api("/api/upload", { method: "POST", body: form });
    socket.emit("private:message", { recipient: selectedUser.id, imageUrl: data.imageUrl });
  } catch (err) { toast(err.message); }
};

function updateNotificationButton() {
  const button = $("notificationBtn");
  if (!button) return;
  const supported = "Notification" in window;
  button.classList.toggle("enabled", notificationsEnabled && supported && Notification.permission === "granted");
  button.classList.toggle("denied", supported && Notification.permission === "denied");
  button.title = !supported ? "Browser notifications are not supported" :
    Notification.permission === "denied" ? "Notifications are blocked in browser settings" :
    notificationsEnabled && Notification.permission === "granted" ? "Notifications enabled" :
    "Enable browser notifications";
  button.setAttribute("aria-label", button.title);
  button.textContent = notificationsEnabled && supported && Notification.permission === "granted" ? "♧" : "♧";
}
async function enableNotifications() {
  if (!("Notification" in window)) {
    toast("Your browser does not support notifications");
    return;
  }
  if (Notification.permission === "denied") {
    toast("Notifications are blocked. Allow them in your browser site settings.");
    updateNotificationButton();
    return;
  }
  try {
    const permission = Notification.permission === "granted"
      ? "granted" : await Notification.requestPermission();
    notificationsEnabled = permission === "granted";
    localStorage.setItem("chatspace_notifications", notificationsEnabled ? "on" : "off");
    updateNotificationButton();
    toast(notificationsEnabled ? "Desktop notifications enabled" : "Notification permission not granted");
  } catch {
    toast("Could not enable notifications");
  }
}
$("notificationBtn").onclick = enableNotifications;
function showMessageNotification(message) {
  if (!notificationsEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
  if (message.sender === me.id) return;
  const sender = users.find(user => user.id === message.sender);
  const senderName = sender ? sender.name : "New message";
  const body = message.imageUrl ? "📷 Sent you a photo" : (message.text || "Sent you a message");
  try {
    const notification = new Notification(senderName, {
      body: body.slice(0, 120),
      icon: "/favicon.ico",
      tag: `chatspace-${message.sender}`
    });
    notification.onclick = () => {
      window.focus();
      const user = users.find(item => item.id === message.sender);
      if (user) openConversation(user);
      notification.close();
    };
  } catch {
    // Browser notification APIs may be unavailable in some embedded contexts.
  }
}
function handleIncomingMessage(message) {
  addMessage(message);
  if (message.sender === me.id) return;
  const isOpenConversation = selectedUser && selectedUser.id === message.sender;
  const shouldNotify = !isOpenConversation || document.hidden;
  if (shouldNotify) {
    unreadCounts[message.sender] = (unreadCounts[message.sender] || 0) + 1;
    renderUsers();
    showMessageNotification(message);
  }
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on("connect_error", err => toast(err.message));
  socket.on("presence:init", ids => { onlineIds = new Set(ids); renderUsers(); updateChatStatus(); });
  socket.on("presence", event => {
    if (event.online) onlineIds.add(event.userId); else onlineIds.delete(event.userId);
    renderUsers(); updateChatStatus();
  });
  socket.on("private:message", handleIncomingMessage);
  socket.on("chat:error", toast);
  socket.on("call:signal", handleCallSignal);
  socket.on("call:unavailable", () => { toast("This person is offline or unavailable"); cleanupCall(); });
}

// WebRTC calls. Signaling is relayed by Socket.IO; media flows peer-to-peer.
async function startCall(video) {
  if (!selectedUser) return;
  try {
    currentCallPeer = selectedUser.id; incomingCall = false;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.ontrack = event => {
      $("remoteVideo").srcObject = event.streams[0];
      $("remoteVideo").style.display = video ? "block" : "none";
      $("callStatus").textContent = "Connected";
    };
    pc.onicecandidate = event => {
      if (event.candidate) socket.emit("call:signal", { to: currentCallPeer, type: "ice", candidate: event.candidate });
    };
    $("callAvatar").textContent = initials(selectedUser.name);
    $("callTitle").textContent = `${video ? "Video" : "Voice"} call · ${selectedUser.name}`;
    $("callStatus").textContent = "Calling...";
    $("localVideo").srcObject = localStream;
    $("localVideo").style.display = video ? "block" : "none";
    $("callModal").classList.remove("hidden");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("call:signal", { to: currentCallPeer, type: "offer", offer, video });
  } catch (err) {
    toast("Could not start call. Check camera/microphone permissions.");
    await cleanupCall();
  }
}
async function handleCallSignal(data) {
  try {
    if (data.type === "offer") {
      if (pc) { socket.emit("call:signal", { to: data.from, type: "busy" }); return; }
      const caller = users.find(u => u.id === data.from) || { id: data.from, name: "ChatSpace user" };
      selectedUser = caller; incomingCall = true; currentCallPeer = data.from;
      renderUsers(); $("emptyState").classList.add("hidden"); $("chatPanel").classList.remove("hidden");
      $("chatName").textContent = caller.name; $("chatAvatar").textContent = initials(caller.name); updateChatStatus();
      $("callAvatar").textContent = initials(caller.name);
      $("callTitle").textContent = `Incoming ${data.video ? "video" : "voice"} call`;
      $("callStatus").textContent = `${caller.name} is calling…`;
      $("localVideo").style.display = "none"; $("remoteVideo").style.display = data.video ? "block" : "none";
      $("callModal").classList.remove("hidden");
      $("endCallBtn").textContent = "Decline";
      $("callStatus").innerHTML = "";
      const accept = document.createElement("button");
      accept.className = "primary"; accept.textContent = "Accept call"; accept.style.marginTop = "18px";
      accept.onclick = () => acceptCall(data);
      $("callStatus").appendChild(accept);
      return;
    }
    if (data.from !== currentCallPeer) return;
    if (data.type === "answer" && pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    if (data.type === "ice" && pc && data.candidate) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    if (data.type === "hangup") { toast("Call ended"); await cleanupCall(); }
    if (data.type === "busy") { toast("User is busy"); await cleanupCall(); }
  } catch (err) { toast("Call connection failed"); await cleanupCall(); }
}
async function acceptCall(data) {
  try {
    const video = !!data.video;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.ontrack = event => { $("remoteVideo").srcObject = event.streams[0]; $("callStatus").textContent = "Connected"; };
    pc.onicecandidate = event => {
      if (event.candidate) socket.emit("call:signal", { to: currentCallPeer, type: "ice", candidate: event.candidate });
    };
    $("localVideo").srcObject = localStream;
    $("localVideo").style.display = video ? "block" : "none";
    $("remoteVideo").style.display = video ? "block" : "none";
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("call:signal", { to: currentCallPeer, type: "answer", answer });
    $("callStatus").textContent = "Connecting…";
    $("endCallBtn").textContent = "✕";
  } catch (err) { toast("Could not accept call. Check permissions."); await cleanupCall(); }
}
async function cleanupCall() {
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
  $("localVideo").srcObject = null; $("remoteVideo").srcObject = null;
  $("localVideo").style.display = "none"; $("remoteVideo").style.display = "none";
  $("callModal").classList.add("hidden"); $("endCallBtn").textContent = "✕";
  currentCallPeer = null; incomingCall = false;
}
$("voiceCallBtn").onclick = () => startCall(false);
$("videoCallBtn").onclick = () => startCall(true);
$("endCallBtn").onclick = () => {
  if (currentCallPeer && socket && !incomingCall) socket.emit("call:signal", { to: currentCallPeer, type: "hangup" });
  else if (currentCallPeer && socket && incomingCall) socket.emit("call:signal", { to: currentCallPeer, type: "hangup" });
  cleanupCall();
};

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && selectedUser) {
    unreadCounts[selectedUser.id] = 0;
    renderUsers();
  }
});

(async function init() {
  setAuthMode("login");
  updateNotificationButton();
  if (token) await startApp();
})();
