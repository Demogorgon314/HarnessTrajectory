import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@harness-trajectory/ui/theme.css'
// After the theme: the Context dashboard's sheets read its `--dsw-*` tokens
// and must win same-specificity ties against nothing in it.
import '@harness-trajectory/context/styles.css'
import './global.css'
import { App } from './App.tsx'
import { bootTheme } from './theme.ts'

bootTheme()

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root')
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
