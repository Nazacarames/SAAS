import { useState } from 'react';
import {
  Container,
  Paper,
  TextField,
  Button,
  Typography,
  Box,
  Stack
} from '@mui/material';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../services/api';
import { toast } from 'react-toastify';
import { useAuth } from '../../context/Auth/AuthContext';

const Register = () => {
  const navigate = useNavigate();
  const { handleLogin } = useAuth();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    companyName: '',
    name: '',
    email: '',
    password: ''
  });

  const onChange = (k: string, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/register', form);
      await handleLogin(form.email, form.password);
      toast.success('Cuenta creada. Trial de 30 días activado.');
      navigate('/');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'No se pudo crear la cuenta');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container component='main' maxWidth='sm'>
      <Box sx={{ marginTop: 6, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Paper elevation={3} sx={{ p: 4, width: '100%' }}>
          <Typography component='h1' variant='h5' align='center' gutterBottom>
            Crear cuenta
          </Typography>
          <Typography variant='body2' align='center' color='text.secondary' sx={{ mb: 2 }}>
            Empezá con trial de 30 días. No requiere intervención manual.
          </Typography>

          <form onSubmit={handleSubmit}>
            <Stack spacing={1.5}>
              <TextField label='Empresa' required value={form.companyName} onChange={(e) => onChange('companyName', e.target.value)} />
              <TextField label='Tu nombre' required value={form.name} onChange={(e) => onChange('name', e.target.value)} />
              <TextField label='Correo electrónico' required type='email' value={form.email} onChange={(e) => onChange('email', e.target.value)} />
              <TextField label='Contraseña (mín 8)' required type='password' value={form.password} onChange={(e) => onChange('password', e.target.value)} />
              <Button type='submit' variant='contained' disabled={loading}>
                {loading ? 'Creando cuenta...' : 'Crear cuenta'}
              </Button>
            </Stack>
          </form>

          <Typography variant='body2' sx={{ mt: 2 }}>
            ¿Ya tenés cuenta? <Link to='/login'>Iniciá sesión</Link>
          </Typography>
        </Paper>
      </Box>
    </Container>
  );
};

export default Register;
