import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installCrashReporting } from './clientEvents'
import { applyTheme, storedTheme } from './theme'

// Before render, so a throw during the first paint still gets reported rather
// than leaving a TO on a blank screen we never hear about.
installCrashReporting()

// index.html already set the palette before paint; this re-applies it only to
// fill in theme-color, which needs the stylesheet loaded to read --bg.
applyTheme(storedTheme())

// Following the device means following it while the app is open too — phones
// flip at sunset, and a bracket running across it should come with.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (storedTheme() === 'system') applyTheme('system')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
