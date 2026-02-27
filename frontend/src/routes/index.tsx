import { Routes as RouterRoutes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '../context/Auth/AuthContext';
import Login from '../pages/Login';
import Dashboard from '../pages/Dashboard';
import Conversations from '../pages/Conversations';
import Contacts from '../pages/Contacts';
import Leads from '../pages/Leads';
import Connections from '../pages/Connections';
import Users from '../pages/Users';
import Integrations from '../pages/Integrations';
import Settings from '../pages/Settings';
import AIAgents from '../pages/AIAgents';
import Knowledge from '../pages/Knowledge';
import Agenda from '../pages/Agenda';
import Funnel from '../pages/Funnel';
import Templates from '../pages/Templates';
import Reports from '../pages/Reports';
import MainLayout from '../layout/MainLayout';

const PrivateRoute = ({ children }: { children: JSX.Element }) => {
  const { isAuth, loading } = useAuth();

  if (loading) {
    return <div>Cargando...</div>;
  }

  return isAuth ? children : <Navigate to='/login' />;
};

const Routes = () => {
  const { isAuth } = useAuth();

  return (
    <RouterRoutes>
      <Route path='/login' element={isAuth ? <Navigate to='/' /> : <Login />} />

      <Route
        path='/'
        element={
          <PrivateRoute>
            <MainLayout />
          </PrivateRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path='tickets' element={<Navigate to='/conversations' replace />} />
        <Route path='conversations' element={<Conversations />} />
        <Route path='contacts' element={<Contacts />} />
        <Route path='leads' element={<Leads />} />
        <Route path='agenda' element={<Agenda />} />
        <Route path='connections' element={<Connections />} />
        <Route path='users' element={<Users />} />
        <Route path='queues' element={<Navigate to='/conversations' replace />} />
        <Route path='integrations' element={<Integrations />} />
        <Route path='settings' element={<Settings />} />
        <Route path='ai-agents' element={<AIAgents />} />
        <Route path='knowledge' element={<Knowledge />} />
        <Route path='funnel' element={<Funnel />} />
        <Route path='webhooks' element={<Navigate to='/integrations' replace />} />
        <Route path='templates' element={<Templates />} />
        <Route path='reports' element={<Reports />} />
      </Route>

      <Route path='*' element={<Navigate to='/' />} />
    </RouterRoutes>
  );
};

export default Routes;
