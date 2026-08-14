import { useState } from 'react';
import { Globe, Monitor, FileCode, Terminal, Chrome, MessageSquare, Play } from 'lucide-react';

export function WebsiteFavicon({ domain, size = 14 }: { domain: string; size?: number }) {
  const [error, setError] = useState(false);
  if (error || !domain) {
    return <Globe size={size} className="text-accent shrink-0" style={{ color: 'var(--accent)' }} />;
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
      alt=""
      onError={() => setError(true)}
      style={{ width: size, height: size, borderRadius: '4px' }}
      className="shrink-0"
    />
  );
}

export function AppIcon({ appName, size = 14 }: { appName: string; size?: number }) {
  const lower = appName.toLowerCase();
  if (lower.includes('code') || lower.includes('visual studio') || lower.includes('cursor')) {
    return <FileCode size={size} className="shrink-0" style={{ color: '#3b82f6' }} />;
  }
  if (lower.includes('terminal') || lower.includes('powershell') || lower.includes('cmd') || lower.includes('bash')) {
    return <Terminal size={size} className="shrink-0" style={{ color: '#10b981' }} />;
  }
  if (
    lower.includes('chrome') ||
    lower.includes('brave') ||
    lower.includes('firefox') ||
    lower.includes('edge') ||
    lower.includes('safari') ||
    lower.includes('browser')
  ) {
    return <Chrome size={size} className="shrink-0" style={{ color: '#f97316' }} />;
  }
  if (lower.includes('slack') || lower.includes('discord') || lower.includes('teams') || lower.includes('zoom')) {
    return <MessageSquare size={size} className="shrink-0" style={{ color: '#8b5cf6' }} />;
  }
  if (lower.includes('spotify') || lower.includes('youtube') || lower.includes('netflix') || lower.includes('vlc')) {
    return <Play size={size} className="shrink-0" style={{ color: '#ef4444' }} />;
  }
  return <Monitor size={size} className="text-muted shrink-0" />;
}
