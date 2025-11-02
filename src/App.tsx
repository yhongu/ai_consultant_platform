import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { ConsultantsPage } from './pages/ConsultantsPage';
import { ConsultantDetailPage } from './pages/ConsultantDetailPage';
import { HistoryPage } from './pages/HistoryPage';
import { PrivateRoute } from './components/PrivateRoute';
import { useAuth } from './context/AuthContext';

function App() {
  const { isAuthenticated } = useAuth();

  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={<Navigate to={isAuthenticated ? '/consultants' : '/login'} replace />}
        />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/consultants"
          element={
            <PrivateRoute>
              <ConsultantsPage />
            </PrivateRoute>
          }
        />
        <Route
          path="/consultants/:id"
          element={
            <PrivateRoute>
              <ConsultantDetailPage />
            </PrivateRoute>
          }
        />
        <Route
          path="/history"
          element={
            <PrivateRoute>
              <HistoryPage />
            </PrivateRoute>
          }
        />
      </Routes>
    </Router>
  );
}

export default App;
