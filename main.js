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
let remoteStream = null;
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
  signapseContainer: document.getElementById('signapseContainer'),
  avatarPlaceholder: document.querySelector('#avatarPlaceholder p')
};

// --- WEBRTC CORE ---

/** Initialize Webcam and Mic */
elements.webcamButton.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    remoteStream = new MediaStream();

    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
    };

    elements.webcamVideo.srcObject = localStream;
    elements.remoteVideo.srcObject = remoteStream;

    elements.setupInitial.classList.add('hidden');
    elements.setupActions.classList.remove('hidden');

    // Start gesture recognition once video is ready
    initGestureRecognition();
    initSpeechRecognition();
  } catch (err) {
    console.error("Error accessing media devices:", err);
    alert("Camera/Mic access is required for this app.");
  }
};

/** Create Offer */
elements.callButton.onclick = async () => {
  // Setup Data Channel for captions and gestures
  setupDataChannel(pc.createDataChannel('accessibility'));

  const callDocRef = doc(collection(db, 'calls'));
  const offerCandidates = collection(callDocRef, 'offerCandidates');
  const answerCandidates = collection(callDocRef, 'answerCandidates');

  const callId = callDocRef.id;
  elements.displayMeetId.innerText = `ID: ${callId}`;
  elements.activeCallInfo.classList.remove('hidden');
  elements.setupOverlay.classList.add('hidden');

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

  onSnapshot(callDocRef, (snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription);
    }
  });

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

  onSnapshot(offerCandidates, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });
};

// --- ACCESSIBILITY LOGIC ---

/** Data Channel Setup */
function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => console.log("Data Channel Open");
  dataChannel.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'caption') {
      handleIncomingCaption(data.text);
    } else if (data.type === 'gesture') {
      handleIncomingGesture(data.gesture);
    }
  };
}

/** 1. Speech-to-Text (Hearing -> Deaf) */
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn("Speech Recognition not supported");
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    const currentText = finalTranscript || interimTranscript;
    if (currentText) {
      if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'caption', text: currentText }));
      }
    }
  };

  recognition.onerror = (err) => console.error("Speech Recognition Error:", err);
  recognition.start();
}

/** 2. Handle Incoming Captions (Deaf User's View) */
function handleIncomingCaption(text) {
  elements.captionOverlay.innerText = text;
  elements.avatarPlaceholder.innerText = "Signing: " + text.substring(0, 30) + "...";

  clearTimeout(elements.captionOverlay.timeout);
  elements.captionOverlay.timeout = setTimeout(() => {
    elements.captionOverlay.innerText = "";
  }, 5000);
}

/** 3. Gesture Recognition (Deaf -> Hearing) */
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
  const canvasCtx = elements.gestureCanvas.getContext('2d');
  canvasCtx.clearRect(0, 0, elements.gestureCanvas.width, elements.gestureCanvas.height);

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

  speakText(gesture);

  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'gesture', gesture: gesture }));
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
  speakText(gesture);
  setTimeout(() => elements.gestureToast.style.opacity = 0, 3000);
}

function speakText(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.speak(utterance);
}

// --- CONTROLS ---

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
  elements.videoBtn.querySelector('.btn-label').innerText = isVideoOff ? 'Start Video' : 'Stop Video';
};

elements.captionBtn.onclick = () => {
  const active = elements.captionBtn.classList.toggle('active');
  elements.captionOverlay.style.display = active ? 'flex' : 'none';
};

elements.aslBtn.onclick = () => {
  const active = elements.aslBtn.classList.toggle('active');
  elements.signapseContainer.style.display = active ? 'flex' : 'none';
};

elements.hangupButton.onclick = () => {
  location.reload();
};
