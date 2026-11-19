import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import StartupScreen from './components/StartupScreen';
import { openStorage } from './utils/storage';
import './App.css';

const root = ReactDOM.createRoot(document.getElementById('root'));

// The data loads before the app renders, so everything that runs on open (Bank Sync's sync-on-open)
// sees it
function start() {
  root.render(<StartupScreen />);
  openStorage().then(
    (store) => root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <App store={store} />
          </BrowserRouter>
        </ErrorBoundary>
      </React.StrictMode>
    ),
    (error) => root.render(<StartupScreen error={error} onRetry={start} />)
  );
}

start();
