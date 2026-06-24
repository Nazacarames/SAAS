import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TextField, Button, Typography, Box, Stack, CircularProgress } from '@mui/material';
import { useAuth } from '../../context/Auth/AuthContext';
import { toast } from 'react-toastify';
import api from '../../services/api';

const Register = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { handleLogin } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/register', { name, email, password });
      await handleLogin(email, password);
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Error al crear cuenta');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', background: '#0C0E12', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Box sx={{ width: '100%', maxWidth: 400 }}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 4 }}>
          <Box sx={{ width: 32, height: 32, borderRadius: '9px', background: 'linear-gradient(135deg, #F5B840 0%, #C07818 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: '0.85rem', color: '#0C0E12' }}>L</Typography>
          </Box>
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, color: '#E8EBF2' }}>LMTM CRM</Typography>
        </Stack>

        <Box className="anim-fade-up">
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.5rem', color: '#E8EBF2', mb: 0.5 }}>
            Crear cuenta
          </Typography>
          <Typography sx={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.40)', mb: 3 }}>
            Completa los datos para comenzar
          </Typography>
        </Box>

        <form onSubmit={handleSubmit}>
          <Stack spacing={2} className="anim-fade-up anim-fade-up-1">
            <TextField fullWidth label="Nombre" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            <TextField fullWidth label="Correo electronico" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <TextField fullWidth label="Contrasena" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Button type="submit" fullWidth variant="contained" size="large" disabled={loading} sx={{ py: 1.4 }}>
              {loading ? <CircularProgress size={20} sx={{ color: '#0C0E12' }} /> : 'Crear cuenta'}
            </Button>
          </Stack>
        </form>

        <Typography variant="body2" sx={{ textAlign: 'center', mt: 3, color: 'rgba(255,255,255,0.35)', fontSize: '0.8rem' }}>
          Ya tenes cuenta?{' '}
          <Link to="/login" style={{ color: '#E8A020', textDecoration: 'none', fontWeight: 600 }}>Ingresar</Link>
        </Typography>
      </Box>
    </Box>
  );
};

export default Register;
