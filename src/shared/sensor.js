"use strict";

/**
 * Shared sensor module.
 *
 * Provides a clean API for DeviceMotion recording that can be used
 * by Lab, Playground, and Game code alike.
 *
 * API:
 *   SensorKit.init(callbacks)        – probe/request permission, start listening
 *   SensorKit.requestPermission()    – iOS 13+ user-gesture permission flow
 *   SensorKit.startRecording()       – begin collecting samples
 *   SensorKit.stopRecording()        – stop collecting, return samples array
 *   SensorKit.getSamples()           – get samples collected so far
 *   SensorKit.isReady()              – true once sensor delivers real data
 *   SensorKit.isRecording()          – true while collecting
 *   SensorKit.latest()               – { acc, gyr } latest readings
 */
export const SensorKit = (() => {
  let ready = false;
  let recording = false;
  let samples = [];
  let recordingStart = 0;
  let listenerAttached = false;

  let latestAcc = { x: 0, y: 0, z: 0 };
  let latestGyr = { x: 0, y: 0, z: 0 };

  // Callbacks: { onReady, onPermissionNeeded, onError }
  let callbacks = {};

  function onMotion(e) {
    const acc = e.accelerationIncludingGravity || e.acceleration || {};
    const gyr = e.rotationRate || {};

    latestAcc = { x: acc.x ?? 0, y: acc.y ?? 0, z: acc.z ?? 0 };
    latestGyr = {
      x: ((gyr.alpha ?? 0) * Math.PI) / 180,
      y: ((gyr.beta ?? 0) * Math.PI) / 180,
      z: ((gyr.gamma ?? 0) * Math.PI) / 180,
    };

    if (recording) {
      const t = Date.now() - recordingStart;
      samples.push({
        t,
        ax: +latestAcc.x.toFixed(4),
        ay: +latestAcc.y.toFixed(4),
        az: +latestAcc.z.toFixed(4),
        gx: +latestGyr.x.toFixed(4),
        gy: +latestGyr.y.toFixed(4),
        gz: +latestGyr.z.toFixed(4),
      });
    }
  }

  function attachListener() {
    if (listenerAttached) return;
    listenerAttached = true;

    let gotRealData = false;
    let checkTimeout = null;

    function wrappedOnMotion(e) {
      const acc = e.accelerationIncludingGravity || e.acceleration || {};
      if (!gotRealData) {
        const hasData =
          (acc.x != null && acc.x !== 0) ||
          (acc.y != null && acc.y !== 0) ||
          (acc.z != null && acc.z !== 0);
        if (hasData) {
          gotRealData = true;
          clearTimeout(checkTimeout);
          ready = true;
          if (callbacks.onReady) callbacks.onReady();
        }
      }
      onMotion(e);
    }

    window.addEventListener("devicemotion", wrappedOnMotion);

    checkTimeout = setTimeout(() => {
      if (!gotRealData) {
        let reason = "Sensors not responding.";
        if (
          window.location.protocol === "http:" &&
          window.location.hostname !== "localhost" &&
          window.location.hostname !== "127.0.0.1"
        ) {
          reason = "Sensors require HTTPS!";
        }
        if (callbacks.onError) callbacks.onError(reason);
      }
    }, 1500);

    // Optimistically mark ready so recording isn't blocked
    ready = true;
  }

  async function requestPermission() {
    if (
      typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function"
    ) {
      const result = await DeviceMotionEvent.requestPermission();
      if (result !== "granted") throw new Error("Permission denied");
    }
    attachListener();
  }

  function init(cbs = {}) {
    callbacks = cbs;

    if (typeof DeviceMotionEvent === "undefined") {
      if (callbacks.onError) callbacks.onError("No motion sensors on this device.");
      return;
    }

    if (typeof DeviceMotionEvent.requestPermission === "function") {
      // iOS 13+ — probe whether permission was already granted
      let alreadyGranted = false;
      function probeHandler(e) {
        const acc = e.accelerationIncludingGravity || e.acceleration || {};
        const hasData =
          (acc.x != null && acc.x !== 0) ||
          (acc.y != null && acc.y !== 0) ||
          (acc.z != null && acc.z !== 0);
        if (hasData) {
          alreadyGranted = true;
          window.removeEventListener("devicemotion", probeHandler);
          attachListener();
        }
      }
      window.addEventListener("devicemotion", probeHandler);
      setTimeout(() => {
        if (!alreadyGranted) {
          window.removeEventListener("devicemotion", probeHandler);
          if (callbacks.onPermissionNeeded) callbacks.onPermissionNeeded();
        }
      }, 1000);
    } else {
      attachListener();
    }
  }

  function startRecording() {
    samples = [];
    recordingStart = Date.now();
    recording = true;
  }

  function stopRecording() {
    recording = false;
    const result = samples.slice();
    samples = [];
    return result;
  }

  return {
    init,
    requestPermission,
    startRecording,
    stopRecording,
    getSamples: () => samples.slice(),
    isReady: () => ready,
    isRecording: () => recording,
    latest: () => ({ acc: { ...latestAcc }, gyr: { ...latestGyr } }),
  };
})();
