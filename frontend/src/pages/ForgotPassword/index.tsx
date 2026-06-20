import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TextField, Button, Typography, Box, Stack, CircularProgress } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setSent(true);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Error al enviar el email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', background: '#0C0E12', alignItems: 'center', justifyContent: 'center', p: 2.5 }}>
      <Box sx={{ width: '100%', maxWidth: 400 }}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 4 }}>
          <Box sx={{ width: 30, height: 30, borderRadius: '8px', background: 'linear-gradient(135deg, #F5B840 0%, #C07818 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: '0.8rem', color: '#0C0E12' }}>L</Typography>
          </Box>
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, color: '#E8EBF2', fontSize: '0.95rem' }}>LMTM CRM</Typography>
        </Stack>

        {sent ? (
          <Box className="anim-fade-up">
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.4rem', color: '#E8EBF2', mb: 1 }}>
              Revisá tu email
            </Typography>
            <Typography sx={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.5)', mb: 3, lineHeight: 1.6 }}>
              Si existe una cuenta con <strong style={{ color: '#E8A020' }}>{email}</strong>, vas a recibir un enlace para restablecer tu contraseña. Revisá también la carpeta de spam.
            </Typography>
            <Link to="/login" style={{ color: '#E8A020', textDecoration: 'none', fontWeight: 600, fontSize: '0.85rem' }}>
              Volver al login
            </Link>
          </Box>
        ) : (
          <>
            <Box className="anim-fade-up">
              <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.4rem', color: '#E8EBF2', mb: 0.4 }}>
                Recuperar contraseña
              </Typography>
              <Typography sx={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.38)', mb: 3 }}>
                Ingresá tu email y te enviamos un enlace para restablecer tu contraseña
              </Typography>
            </Box>

            <form onSubmit={handleSubmit}>
              <Stack spacing={2} className="anim-fade-up anim-fade-up-1">
                <TextField
                  fullWidth
                  label="Correo electrónico"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <Button
                  type="submit"
                  fullWidth
                  variant="contained"
                  size="large"
                  disabled={loading}
                  sx={{ py: 1.4, fontSize: '0.9rem' }}
                >
                  {loading ? <CircularProgress size={20} sx={{ color: '#0C0E12' }} /> : 'Enviar enlace'}
                </Button>
              </Stack>
            </form>

            <Typography sx={{ textAlign: 'center', mt: 3, color: 'rgba(255,255,255,0.32)', fontSize: '0.8rem' }}>
              <Link to="/login" style={{ color: 'rgba(255,255,255,0.5)', textDecoration: 'none' }}>Volver al login</Link>
            </Typography>
          </>
        )}
      </Box>
    </Box>
  );
};

export default ForgotPassword;
