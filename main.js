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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

// --- GLOBAL STATE ---
const pc = new RTCPeerConnection(servers);
let dataChannel = null;
let localStream = null;
let screenStream = null;
let remoteStream = new MediaStream();
let recognition = null;
let isMuted = false;
let isVideoOff = false;

// HTML Elements
const elements = {
  webcamButton: document.getElementById('webcamButton'),
  webcamVideo: document.getElementById('webcamVideo'),
  callButton: document.getElementById('callButton'),
  callInput: document.getElementById('callInput'),
  answerButton: document.getElementById('answerButton'),
  remoteVideo: document.getElementById('remoteVideo'),
  hangupButton: document.getElementById('hangupButton'),
  setupOverlay: document.getElementById('setupOverlay'),
  setupInitial: document.getElementById('setupInitial'),
  setupActions: document.getElementById('setupActions'),
  displayMeetId: document.getElementById('displayMeetId'),
  activeCallInfo: document.getElementById('activeCallInfo'),
  captionOverlay: document.getElementById('captionOverlay'),
  gestureCanvas: document.getElementById('gestureCanvas'),
  gestureToast: document.getElementById('gestureToast'),
  muteBtn: document.getElementById('muteBtn'),
  videoBtn: document.getElementById('videoBtn'),
  captionBtn: document.getElementById('captionBtn'),
  aslBtn: document.getElementById('aslBtn'),
  shareBtn: document.getElementById('shareBtn'),
  chatBtn: document.getElementById('chatBtn'),
  sidePanel: document.getElementById('sidePanel'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  sendChatBtn: document.getElementById('sendChatBtn'),
  copyBtn: document.getElementById('copyBtn'),
  connectionStatus: document.getElementById('connectionStatus'),
  sttStatus: document.getElementById('sttStatus'),
  signapseContainer: document.getElementById('signapseContainer'),
  avatarPlaceholder: document.querySelector('#avatarPlaceholder p')
};

// --- WEBRTC CORE ---

/** Initialize Webcam and Mic */
elements.webcamButton.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

    // Attach local stream to video element
    elements.webcamVideo.srcObject = localStream;
    elements.remoteVideo.srcObject = remoteStream;

    // Add local tracks to peer connection
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    // Handle remote tracks
    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
      console.log("Remote track added and attached.");
      elements.connectionStatus.innerText = "Connected";
    };

    elements.setupInitial.classList.add('hidden');
    elements.setupActions.classList.remove('hidden');

    // Check for ID in URL to auto-fill
    const urlParams = new URLSearchParams(window.location.search);
    const meetingId = urlParams.get('id');
    if (meetingId) {
      elements.callInput.value = meetingId;
    }

    initGestureRecognition();
    initSpeechRecognition();
  } catch (err) {
    console.error("Error accessing media devices:", err);
    alert("Camera/Mic access is required.");
  }
};

/** Create Offer */
elements.callButton.onclick = async () => {
  // Create accessibility and chat data channel
  setupDataChannel(pc.createDataChannel('symphony-data'));

  const callDocRef = doc(collection(db, 'calls'));
  const offerCandidates = collection(callDocRef, 'offerCandidates');
  const answerCandidates = collection(callDocRef, 'answerCandidates');

  const callId = callDocRef.id;
  elements.displayMeetId.innerText = `ID: ${callId}`;
  elements.activeCallInfo.classList.remove('hidden');
  elements.setupOverlay.classList.add('hidden');
  elements.connectionStatus.innerText = "Waiting for remote...";

  pc.onicecandidate = (event) => {
    event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
  };

  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  const offer = {
    sdp: offerDescription.sdp,
    type: offerDescription.type,
  };

  await setDoc(callDocRef, { offer });

  // Listen for answer
  onSnapshot(callDocRef, (snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription);
    }
  });

  // Add remote candidates
  onSnapshot(answerCandidates, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });
};

/** Join Call */
elements.answerButton.onclick = async () => {
  const callId = elements.callInput.value;
  if (!callId) return alert("Please enter a Meeting ID");

  const callDocRef = doc(db, 'calls', callId);
  const answerCandidates = collection(callDocRef, 'answerCandidates');
  const offerCandidates = collection(callDocRef, 'offerCandidates');

  elements.displayMeetId.innerText = `ID: ${callId}`;
  elements.activeCallInfo.classList.remove('hidden');
  elements.setupOverlay.classList.add('hidden');
  elements.connectionStatus.innerText = "Joining...";

  pc.ondatachannel = (event) => {
    setupDataChannel(event.channel);
  };

  pc.onicecandidate = (event) => {
    event.candidate && addDoc(answerCandidates, event.candidate.toJSON());
  };

  const callData = (await getDoc(callDocRef)).data();
  if (!callData) return alert("Call not found");

  const offerDescription = callData.offer;
  await pc.setRemoteDescription(new RTCSessionDescription(offerDescription));

  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);

  const answer = {
    type: answerDescription.type,
    sdp: answerDescription.sdp,
  };

  await updateDoc(callDocRef, { answer });

  // Add offerer candidates
  onSnapshot(offerCandidates, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });
};

// --- DATA CHANNEL & CHAT ---

function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => {
    console.log("Data Channel Ready");
    appendMessage("System", "Chat connected", "remote");
  };

  dataChannel.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case 'caption': handleIncomingCaption(data.text); break;
      case 'gesture': handleIncomingGesture(data.gesture); break;
      case 'chat': appendMessage("Remote", data.text, "remote"); break;
    }
  };
}

function sendChatMessage() {
  const text = elements.chatInput.value.trim();
  if (text && dataChannel?.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'chat', text }));
    appendMessage("You", text, "local");
    elements.chatInput.value = "";
  }
}

function appendMessage(sender, text, type) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${type}`;
  msgDiv.innerHTML = `<strong>${sender}:</strong> ${text}`;
  elements.chatMessages.appendChild(msgDiv);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

elements.sendChatBtn.onclick = sendChatMessage;
elements.chatInput.onkeypress = (e) => e.key === 'Enter' && sendChatMessage();

// --- ACCESSIBILITY ACTIONS ---

/** 1. Speech-to-Text */
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      transcript += event.results[i][0].transcript;
    }
    if (dataChannel?.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'caption', text: transcript }));
    }
  };

  recognition.start();
  elements.sttStatus.classList.remove('hidden');
}

function handleIncomingCaption(text) {
  elements.captionOverlay.innerText = text;
  elements.captionOverlay.classList.remove('hidden');
  elements.avatarPlaceholder.innerText = "Signing: " + text.substring(0, 30) + "...";

  clearTimeout(elements.captionOverlay.timeout);
  elements.captionOverlay.timeout = setTimeout(() => {
    elements.captionOverlay.classList.add('hidden');
  }, 4000);
}

/** 2. Hand Gestures */
async function initGestureRecognition() {
  const resizeCanvas = () => {
    elements.gestureCanvas.width = elements.webcamVideo.videoWidth || 640;
    elements.gestureCanvas.height = elements.webcamVideo.videoHeight || 480;
  };
  elements.webcamVideo.onplay = resizeCanvas;

  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7
  });

  hands.onResults(onHandResults);

  const camera = new Camera(elements.webcamVideo, {
    onFrame: async () => {
      await hands.send({ image: elements.webcamVideo });
    },
    width: 640,
    height: 480
  });
  camera.start();
}

function onHandResults(results) {
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const landmarks = results.multiHandLandmarks[0];
    const gesture = detectSimpleGesture(landmarks);
    if (gesture && gesture !== lastGesture) {
      handleLocalGesture(gesture);
    }
  }
}

let lastGesture = null;
let gestureCooldown = false;

function detectSimpleGesture(landmarks) {
  const isThumbUp = landmarks[4].y < landmarks[3].y && landmarks[4].y < landmarks[2].y;
  const isThumbDown = landmarks[4].y > landmarks[3].y && landmarks[4].y > landmarks[2].y;
  const isOpenPalm = landmarks[8].y < landmarks[6].y && landmarks[12].y < landmarks[10].y && landmarks[16].y < landmarks[14].y;

  if (isThumbUp && !isOpenPalm) return "YES";
  if (isThumbDown) return "NO";
  if (isOpenPalm && landmarks[8].y < landmarks[4].y) return "HELLO";
  return null;
}

function handleLocalGesture(gesture) {
  if (gestureCooldown) return;
  lastGesture = gesture;
  gestureCooldown = true;

  elements.gestureToast.innerText = `${gesture} 👋`;
  elements.gestureToast.style.opacity = 1;

  const utterance = new SpeechSynthesisUtterance(gesture);
  window.speechSynthesis.speak(utterance);

  if (dataChannel?.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'gesture', gesture }));
  }

  setTimeout(() => {
    elements.gestureToast.style.opacity = 0;
    gestureCooldown = false;
    lastGesture = null;
  }, 3000);
}

function handleIncomingGesture(gesture) {
  elements.gestureToast.innerText = `Remote: ${gesture}`;
  elements.gestureToast.style.opacity = 1;
  const utterance = new SpeechSynthesisUtterance("Remote user says " + gesture);
  window.speechSynthesis.speak(utterance);
  setTimeout(() => elements.gestureToast.style.opacity = 0, 3000);
}

// --- CALL CONTROLS ---

elements.muteBtn.onclick = () => {
  isMuted = !isMuted;
  localStream.getAudioTracks()[0].enabled = !isMuted;
  elements.muteBtn.classList.toggle('active', isMuted);
  elements.muteBtn.querySelector('.icon').innerText = isMuted ? '🔇' : '🎤';
  elements.muteBtn.querySelector('.btn-label').innerText = isMuted ? 'Unmute' : 'Mute';
};

elements.videoBtn.onclick = () => {
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks()[0].enabled = !isVideoOff;
  elements.videoBtn.classList.toggle('active', isVideoOff);
  elements.videoBtn.querySelector('.icon').innerText = isVideoOff ? '📹 Off' : '📹';
};

elements.shareBtn.onclick = async () => {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track.kind === 'video');
    sender.replaceTrack(screenTrack);

    screenTrack.onended = () => {
      sender.replaceTrack(localStream.getVideoTracks()[0]);
    };
  } catch (err) {
    console.error("Screen share failed:", err);
  }
};

elements.chatBtn.onclick = () => {
  elements.sidePanel.classList.toggle('hidden');
  elements.chatBtn.classList.toggle('active');
};

elements.copyBtn.onclick = () => {
  const url = `${window.location.origin}${window.location.pathname}?id=${elements.displayMeetId.innerText.split(': ')[1]}`;
  navigator.clipboard.writeText(url).then(() => {
    alert("Meeting link copied to clipboard!");
  });
};

elements.hangupButton.onclick = () => {
  location.href = window.location.origin + window.location.pathname;
};

// Toggle features
elements.captionBtn.onclick = () => {
  elements.captionOverlay.classList.toggle('hidden');
  elements.captionBtn.classList.toggle('active');
};

elements.aslBtn.onclick = () => {
  elements.signapseContainer.classList.toggle('hidden');
  elements.aslBtn.classList.toggle('active');
};
