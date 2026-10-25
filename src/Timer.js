import React from 'react';

export function formatTime(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function Timer({ timeLeft, lowThresholdSeconds = 300 }) {
  const isLow = timeLeft <= lowThresholdSeconds;
  const isExpired = timeLeft <= 0;

  return (
    <span
      className={isLow ? 'timer timer-low' : 'timer'}
      role="timer"
      aria-label={`Time left ${formatTime(timeLeft)}`}
    >
      {isExpired ? "Time's up" : `Time Left: ${formatTime(timeLeft)}`}
    </span>
  );
}