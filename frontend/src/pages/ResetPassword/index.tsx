import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { TextField, Button, Typography, Box, Stack, CircularProgress, InputAdornment, IconButton } from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const ResetPassword = () => {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error('La contraseña debe tener al menos 8 caracteres');
      return;
    }
    if (password !== confirm) {
      toast.error('Las contraseñas no coinciden');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      toast.success('Contraseña actualizada correctamente');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Error al restablecer la contraseña');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <Box sx={{ display: 'flex', minHeight: '100vh', background: '#0C0E12', alignItems: 'center', justifyContent: 'center', p: 2.5 }}>
        <Box sx={{ textAlign: 'center' }}>
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.4rem', color: '#E8EBF2', mb: 1 }}>
            Enlace inválido
          </Typography>
          <Typography sx={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.5)', mb: 3 }}>
            Este enlace no es válido o expiró. Solicitá uno nuevo.
          </Typography>
          <Link to="/forgot-password" style={{ color: '#E8A020', textDecoration: 'none', fontWeight: 600 }}>
            Solicitar nuevo enlace
          </Link>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', background: '#0C0E12', alignItems: 'center', justifyContent: 'center', p: 2.5 }}>
      <Box sx={{ width: '100%', maxWidth: 400 }}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 4 }}>
          <Box sx={{ width: 30, height: 30, borderRadius: '8px', background: 'linear-gradient(135deg, #F5B840 0%, #C07818 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: '0.8rem', color: '#0C0E12' }}>L</Typography>
          </Box>
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, color: '#E8EBF2', fontSize: '0.95rem' }}>LMTM CRM</Typography>
        </Stack>

        {done ? (
          <Box className="anim-fade-up">
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.4rem', color: '#E8EBF2', mb: 1 }}>
              Contraseña actualizada
            </Typography>
            <Typography sx={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.5)', mb: 3 }}>
              Ya podés iniciar sesión con tu nueva contraseña.
            </Typography>
            <Link to="/login" style={{ color: '#E8A020', textDecoration: 'none', fontWeight: 600, fontSize: '0.9rem' }}>
              Ir al login
            </Link>
          </Box>
        ) : (
          <>
            <Box className="anim-fade-up">
              <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.4rem', color: '#E8EBF2', mb: 0.4 }}>
                Nueva contraseña
              </Typography>
              <Typography sx={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.38)', mb: 3 }}>
                Ingresá tu nueva contraseña (mínimo 8 caracteres)
              </Typography>
            </Box>

            <form onSubmit={handleSubmit}>
              <Stack spacing={2} className="anim-fade-up anim-fade-up-1">
                <TextField
                  fullWidth
                  label="Nueva contraseña"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton size="small" onClick={() => setShowPassword(!showPassword)} edge="end">
                          {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                        </IconButton>
                      </InputAdornment>
                    )
                  }}
                />
                <TextField
                  fullWidth
                  label="Confirmar contraseña"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
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
                  {loading ? <CircularProgress size={20} sx={{ color: '#0C0E12' }} /> : 'Restablecer contraseña'}
                </Button>
              </Stack>
            </form>
          </>
        )}
      </Box>
    </Box>
  );
};

export default ResetPassword;
