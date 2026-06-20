import { useEffect, useState } from 'react';
import {
  Box, Typography, Paper, Stack, Button, Alert, Chip, CircularProgress, Divider
} from '@mui/material';
import { CheckCircle as CheckIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const statusColor = (status: string) => {
  if (status === 'APPROVED') return 'success';
  if (status === 'REJECTED') return 'error';
  if (status === 'PENDING') return 'warning';
  return 'default';
};

const Templates = () => {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [tokenExpired, setTokenExpired] = useState(false);
  const [selectedName, setSelectedName] = useState('');
  const [selectedLang, setSelectedLang] = useState('es_AR');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [{ data: tplData }, { data: selData }] = await Promise.all([
        api.get('/ai/meta/waba-templates'),
        api.get('/ai/meta/selected-template').catch(() => ({ data: { templateName: '', templateLanguage: 'es_AR' } })),
      ]);
      setConnected(tplData.connected ?? false);
      setTemplates(Array.isArray(tplData.templates) ? tplData.templates : []);
      setTokenExpired(Boolean(tplData.tokenExpired));
      if (tplData.error) setError(tplData.error);
      setSelectedName(selData.templateName || '');
      setSelectedLang(selData.templateLanguage || 'es_AR');
    } catch {
      setError('No se pudo cargar los templates.');
      setConnected(false);
      setTokenExpired(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const select = async (name: string, lang: string) => {
    setSaving(true);
    try {
      await api.put('/ai/meta/selected-template', { templateName: name, templateLanguage: lang });
      setSelectedName(name);
      setSelectedLang(lang);
      toast.success(`Template "${name}" seleccionado para auto-contacto`);
    } catch {
      toast.error('No se pudo guardar la selección');
    } finally {
      setSaving(false);
    }
  };

  const approved = templates.filter((t) => t.status === 'APPROVED');
  const others = templates.filter((t) => t.status !== 'APPROVED');

  return (
    <Box>
      <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 2 }}>
        <Typography variant='h4'>Templates de WhatsApp</Typography>
        <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading} variant='outlined' size='small'>
          Actualizar
        </Button>
      </Stack>

      {selectedName && (
        <Alert severity='success' sx={{ mb: 2 }}>
          Template activo para auto-contacto de leads: <strong>{selectedName}</strong> ({selectedLang})
        </Alert>
      )}
      {!selectedName && !loading && (
        <Alert severity='warning' sx={{ mb: 2 }}>
          Ningún template seleccionado. Elegí uno de la lista para auto-contactar leads.
        </Alert>
      )}

      {connected === false && !loading && (
        <Alert severity='error' sx={{ mb: 2 }}>
          {tokenExpired
            ? 'El token de Meta venció. Reconectá OAuth desde Configuración → Meta Lead Ads.'
            : error || 'No hay conexión Meta activa. Configurá el OAuth en Configuración.'}
        </Alert>
      )}
      {connected === true && error && !loading && (
        <Alert severity='error' sx={{ mb: 2 }}>{error}</Alert>
      )}

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {!loading && connected && (
        <Stack spacing={1.5}>
          {approved.length === 0 && others.length === 0 && (
            <Alert severity='info'>No se encontraron templates en la cuenta de WhatsApp Business.</Alert>
          )}

          {approved.length > 0 && (
            <>
              <Typography variant='subtitle1' sx={{ fontWeight: 700 }}>Aprobados ({approved.length})</Typography>
              {approved.map((t) => {
                const isSelected = t.name === selectedName;
                const bodyComp = (t.components || []).find((c: any) => c.type === 'BODY');
                return (
                  <Paper
                    key={`${t.name}-${t.language}`}
                    variant='outlined'
                    sx={{
                      p: 1.5,
                      borderColor: isSelected ? 'success.main' : 'divider',
                      bgcolor: isSelected ? 'rgba(46,125,50,0.08)' : 'transparent',
                    }}
                  >
                    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent='space-between' alignItems={{ sm: 'center' }} spacing={1}>
                      <Box>
                        <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap'>
                          {isSelected && <CheckIcon color='success' fontSize='small' />}
                          <Typography variant='body1' sx={{ fontWeight: 700 }}>{t.name}</Typography>
                          <Chip size='small' label={t.language} />
                          <Chip size='small' label={t.category} variant='outlined' />
                          <Chip size='small' color={statusColor(t.status) as any} label={t.status} />
                        </Stack>
                        {bodyComp?.text && (
                          <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 0.5, fontStyle: 'italic' }}>
                            {String(bodyComp.text).slice(0, 120)}{String(bodyComp.text).length > 120 ? '…' : ''}
                          </Typography>
                        )}
                      </Box>
                      <Button
                        variant={isSelected ? 'contained' : 'outlined'}
                        color='success'
                        size='small'
                        disabled={saving || isSelected}
                        onClick={() => select(t.name, t.language)}
                        sx={{ minWidth: 140 }}
                      >
                        {isSelected ? 'Seleccionado' : 'Usar para leads'}
                      </Button>
                    </Stack>
                  </Paper>
                );
              })}
            </>
          )}

          {others.length > 0 && (
            <>
              <Divider sx={{ my: 1 }} />
              <Typography variant='subtitle1' sx={{ fontWeight: 700, color: 'text.secondary' }}>
                Otros ({others.length})
              </Typography>
              {others.map((t) => (
                <Paper key={`${t.name}-${t.language}`} variant='outlined' sx={{ p: 1.5, opacity: 0.65 }}>
                  <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap'>
                    <Typography variant='body2' sx={{ fontWeight: 700 }}>{t.name}</Typography>
                    <Chip size='small' label={t.language} />
                    <Chip size='small' label={t.category} variant='outlined' />
                    <Chip size='small' color={statusColor(t.status) as any} label={t.status} />
                  </Stack>
                </Paper>
              ))}
            </>
          )}
        </Stack>
      )}
    </Box>
  );
};

export default Templates;
