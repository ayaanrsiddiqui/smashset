import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installCrashReporting } from './clientEvents'

// Before render, so a throw during the first paint still gets reported rather
// than leaving a TO on a blank screen we never hear about.
installCrashReporting()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
