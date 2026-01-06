import './style.css';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  getDoc,
  onSnapshot
} from 'firebase/firestore';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from 'firebase/auth';

// --- CONFIGURATION ---
const firebaseConfig = {
  apiKey: "AIzaSyBSp5r_LeSc9ygP6lmyFu2GErlL3P5rGko",
  authDomain: "symphony-97609.firebaseapp.com",
  projectId: "symphony-97609",
  storageBucket: "symphony-97609.firebasestorage.app",
  messagingSenderId: "987242636260",
  appId: "1:987242636260:web:27b3dd6abb379239a5ddf1",
  measurementId: "G-LFYVC5N6G2"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

const servers = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ],
  iceCandidatePoolSize: 10,
};

// --- GLOBAL STATE ---
const pc = new RTCPeerConnection(servers);
let dataChannel = null;
let localStream = null;
let remoteStream = new MediaStream();
let recognition = null;
let isMuted = false;
let isVideoOff = false;
let isCaptionsOn = false;
let unsubCall = null;
let unsubOffer = null;
let unsubAnswer = null;

const elements = {
  loginSection: document.getElementById('loginSection'),
  loginBtn: document.getElementById('loginBtn'),
  userDisplayName: document.getElementById('userDisplayName'),
  webcamButton: document.getElementById('webcamButton'),
  webcamVideo: document.getElementById('webcamVideo'),
  callInput: document.getElementById('callInput'),
  answerButton: document.getElementById('answerButton'),
  remoteVideo: document.getElementById('remoteVideo'),
  hangupButton: document.getElementById('hangupButton'),
  setupOverlay: document.getElementById('setupOverlay'),
  setupInitial: document.getElementById('setupInitial'),
  displayMeetId: document.getElementById('displayMeetId'),
  captionOverlay: document.getElementById('captionOverlay'),
  muteBtn: document.getElementById('muteBtn'),
  videoBtn: document.getElementById('videoBtn'),
  captionBtn: document.getElementById('captionBtn'),
  shareBtn: document.getElementById('shareBtn'),
  chatBtn: document.getElementById('chatBtn'),
  sidePanel: document.getElementById('sidePanel'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  sendChatBtn: document.getElementById('sendChatBtn'),
  copyBtn: document.getElementById('copyBtn'),
  mainWrapper: document.getElementById('mainWrapper'),
  bottomBar: document.getElementById('bottomBar'),
  meetTime: document.getElementById('meetTime'),
  closePanelBtn: document.getElementById('closePanelBtn'),
  gestureToast: document.getElementById('gestureToast')
};

// --- AUTH LOGIC ---
onAuthStateChanged(auth, (user) => {
  if (user) {
    elements.loginSection.classList.add('hidden');
    elements.setupInitial.classList.remove('hidden');
    elements.userDisplayName.innerText = `Logged in as ${user.displayName}`;

    // Auto-fill ID from URL if present
    const urlParams = new URLSearchParams(window.location.search);
    const meetingId = urlParams.get('id');
    if (meetingId) elements.callInput.value = meetingId;
  } else {
    elements.loginSection.classList.remove('hidden');
    elements.setupInitial.classList.add('hidden');
  }
});

elements.loginBtn.onclick = async () => {
  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error("Auth Error:", error);
  }
};

// --- CLOCK ---
function updateClock() {
  const now = new Date();
  elements.meetTime.innerText = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// --- WEBRTC LOGIC ---
elements.remoteVideo.srcObject = remoteStream;

pc.ontrack = (event) => {
  console.log("Remote track received");
  event.streams[0].getTracks().forEach((track) => {
    remoteStream.addTrack(track);
  });
};

pc.oniceconnectionstatechange = () => {
  console.log("ICE Connection State:", pc.iceConnectionState);
  if (pc.iceConnectionState === 'disconnected') {
    appendMessage("System", "Partner disconnected.", false);
  }
};

async function startMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  elements.webcamVideo.srcObject = localStream;
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  elements.setupOverlay.classList.add('fade-out');
  setTimeout(() => {
    elements.setupOverlay.classList.add('hidden');
    elements.mainWrapper.classList.remove('hidden');
    elements.bottomBar.classList.remove('hidden');
  }, 500);

  initSpeechRecognition();
}

/** Host Logic */
elements.webcamButton.onclick = async () => {
  try {
    await startMedia();
    setupDataChannel(pc.createDataChannel('symphony-data'));

    const callDocRef = doc(collection(db, 'calls'));
    const offerCandidates = collection(callDocRef, 'offerCandidates');
    const answerCandidates = collection(callDocRef, 'answerCandidates');

    elements.displayMeetId.innerText = callDocRef.id;

    pc.onicecandidate = (event) => {
      event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
    };

    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);
    await setDoc(callDocRef, { offer: { sdp: offerDescription.sdp, type: offerDescription.type } });

    unsubCall = onSnapshot(callDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!pc.currentRemoteDescription && data?.answer) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    unsubAnswer = onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && pc.remoteDescription) {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(console.error);
        }
      });
    });

  } catch (err) {
    console.error("Host Error:", err);
  }
};

/** Join Logic */
elements.answerButton.onclick = async () => {
  const callId = elements.callInput.value.trim();
  if (!callId) return alert("Enter code");

  try {
    await startMedia();
    elements.displayMeetId.innerText = callId;

    const callDocRef = doc(db, 'calls', callId);
    const answerCandidates = collection(callDocRef, 'answerCandidates');
    const offerCandidates = collection(callDocRef, 'offerCandidates');

    pc.ondatachannel = (event) => setupDataChannel(event.channel);
    pc.onicecandidate = (event) => {
      event.candidate && addDoc(answerCandidates, event.candidate.toJSON());
    };

    const callData = (await getDoc(callDocRef)).data();
    if (!callData) throw new Error("Meeting not found");

    await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
    const answerDescription = await pc.createAnswer();
    await pc.setLocalDescription(answerDescription);
    await updateDoc(callDocRef, { answer: { type: answerDescription.type, sdp: answerDescription.sdp } });

    unsubOffer = onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && pc.remoteDescription) {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(console.error);
        }
      });
    });

  } catch (err) {
    console.error("Join Error:", err);
    alert(err.message);
  }
};

// --- MESSAGING ---
function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => appendMessage("System", "Encryption active. Secure channel ready.", false);
  dataChannel.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'caption') handleIncomingCaption(data.text);
    if (data.type === 'chat') appendMessage("Partner", data.text, false);
  };
}

function sendChatMessage() {
  const text = elements.chatInput.value.trim();
  if (text && dataChannel?.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'chat', text }));
    appendMessage("You", text, true);
    elements.chatInput.value = "";
  }
}

function appendMessage(sender, text, isLocal) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-bubble ${isLocal ? 'local' : ''}`;
  msgDiv.innerHTML = `<div class="chat-bubble-name">${sender}</div><div>${text}</div>`;
  elements.chatMessages.appendChild(msgDiv);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

elements.sendChatBtn.onclick = sendChatMessage;
elements.chatInput.onkeypress = (e) => e.key === 'Enter' && sendChatMessage();

// --- CAPTIONS ---
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (e) => {
    let transcript = '';
    for (let i = e.resultIndex; i < e.results.length; ++i) transcript += e.results[i][0].transcript;
    if (dataChannel?.readyState === 'open') dataChannel.send(JSON.stringify({ type: 'caption', text: transcript }));
  };
  recognition.onerror = () => recognition.start(); // Auto-restart on silence/timeout
  recognition.start();
}

function handleIncomingCaption(text) {
  if (!isCaptionsOn) return;
  elements.captionOverlay.innerText = text;
  elements.captionOverlay.classList.toggle('hidden', !text);
}

// --- CONTROLS ---
elements.muteBtn.onclick = () => {
  isMuted = !isMuted;
  localStream.getAudioTracks()[0].enabled = !isMuted;
  elements.muteBtn.classList.toggle('active', isMuted);
  elements.muteBtn.innerHTML = `<i class="fa-solid fa-microphone${isMuted ? '-slash' : ''}"></i>`;
};

elements.videoBtn.onclick = () => {
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks()[0].enabled = !isVideoOff;
  elements.videoBtn.classList.toggle('active', isVideoOff);
  elements.videoBtn.innerHTML = `<i class="fa-solid fa-video${isVideoOff ? '-slash' : ''}"></i>`;
};

elements.captionBtn.onclick = () => {
  isCaptionsOn = !isCaptionsOn;
  elements.captionBtn.classList.toggle('active', isCaptionsOn);
  elements.captionOverlay.classList.toggle('hidden', !isCaptionsOn);
};

elements.shareBtn.onclick = async () => {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track.kind === 'video');
    sender.replaceTrack(screenTrack);
    screenTrack.onended = () => sender.replaceTrack(localStream.getVideoTracks()[0]);
  } catch (err) { console.error("Screen Share Failed:", err); }
};

elements.chatBtn.onclick = () => elements.sidePanel.classList.toggle('hidden');
elements.closePanelBtn.onclick = () => elements.sidePanel.classList.add('hidden');

elements.copyBtn.onclick = () => {
  const url = `${window.location.origin}/?id=${elements.displayMeetId.innerText}`;
  navigator.clipboard.writeText(url).then(() => alert("Meeting URL Copied!"));
};

elements.hangupButton.onclick = () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (unsubCall) unsubCall();
  if (unsubOffer) unsubOffer();
  if (unsubAnswer) unsubAnswer();
  location.reload();
};
