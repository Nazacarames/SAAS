import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Typography,
  Box,
  Paper,
  Stack,
  TextField,
  Button,
  Divider,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Chip,
  Grid,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Alert
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const DAY_LABELS = [
  { iso: 1, label: 'Lun' },
  { iso: 2, label: 'Mar' },
  { iso: 3, label: 'Mié' },
  { iso: 4, label: 'Jue' },
  { iso: 5, label: 'Vie' },
  { iso: 6, label: 'Sáb' },
  { iso: 7, label: 'Dom' }
];

// Fallback persona templates when the backend table is empty.
// Written for non-technical real-estate users: pick one, adjust, save.
const BUILTIN_TEMPLATES = [
  {
    id: 'captador',
    name: 'Captador de leads',
    description: 'Recibe consultas, pide zona, presupuesto y tipo de propiedad.',
    templateBody:
      'Sos un asesor inmobiliario cordial y profesional. Tu objetivo es entender qué busca el cliente: operación (compra o alquiler), tipo de propiedad, zona y presupuesto máximo. Pedí UN dato por mensaje, en orden. Cuando tengas todo, buscá propiedades. Respondé siempre en español, breve y claro.',
    welcomeMsgTemplate: '¡Hola! Soy el asistente de la inmobiliaria. ¿Buscás comprar o alquilar?'
  },
  {
    id: 'agendador',
    name: 'Agendador de visitas',
    description: 'Coordina visitas a propiedades y confirma fecha y hora.',
    templateBody:
      'Sos un asistente que coordina visitas a propiedades. Cuando el cliente muestre interés en una propiedad, ofrecé coordinar una visita. Pedí día y franja horaria preferida, confirmá los datos de contacto (nombre y teléfono) y agendá la cita. Sé cordial y resolutivo, en español.',
    welcomeMsgTemplate: '¡Hola! ¿Te interesa visitar alguna propiedad? Te ayudo a coordinar día y horario.'
  },
  {
    id: 'calificador',
    name: 'Calificador de consultas',
    description: 'Responde preguntas frecuentes y deriva a un vendedor cuando hay interés real.',
    templateBody:
      'Sos un asistente que responde consultas generales usando la base de conocimiento de la empresa. Si el cliente muestra intención clara de compra o alquiler, pedí su nombre y email para que un asesor humano lo contacte. No inventes información: si no sabés algo, decilo y ofrecé derivar la consulta.',
    welcomeMsgTemplate: '¡Hola! Contame en qué te puedo ayudar y si hace falta te conecto con un asesor.'
  }
];

type TestMsg = { fromMe: boolean; body: string };

const AIAgents = () => {
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('Asistente');
  const [persona, setPersona] = useState('');
  const [welcomeMsg, setWelcomeMsg] = useState('');
  const [offhoursMsg, setOffhoursMsg] = useState('');
  const [farewellMsg, setFarewellMsg] = useState('');
  const [bhStart, setBhStart] = useState('');
  const [bhEnd, setBhEnd] = useState('');
  const [bhDays, setBhDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);

  const [personaTemplates, setPersonaTemplates] = useState<any[]>([]);

  const [searchQuery, setSearchQuery] = useState('precio');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  // Test chat
  const [testMessages, setTestMessages] = useState<TestMsg[]>([]);
  const [testInput, setTestInput] = useState('');
  const [testSending, setTestSending] = useState(false);
  const testEndRef = useRef<HTMLDivElement | null>(null);

  const fetchAgents = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/ai/agents');
      setAgents(Array.isArray(data) ? data : []);
    } catch {
      toast.error('No se pudo cargar Agente IA');
    } finally {
      setLoading(false);
    }
  };

  const fetchTemplates = async () => {
    try {
      const { data } = await api.get('/ai/persona-templates');
      setPersonaTemplates(Array.isArray(data) && data.length > 0 ? data : BUILTIN_TEMPLATES);
    } catch {
      setPersonaTemplates(BUILTIN_TEMPLATES);
    }
  };

  useEffect(() => {
    fetchAgents();
    fetchTemplates();
  }, []);

  useEffect(() => {
    testEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [testMessages]);

  // Only a truly active agent counts. No silent fallback to agents[0]:
  // showing an inactive agent as "Activo" misleads the user.
  const activeAgent = useMemo(() => agents.find((a) => a.is_active) || null, [agents]);

  const resetForm = () => {
    setEditingId(null);
    setName('Asistente');
    setPersona('');
    setWelcomeMsg('');
    setOffhoursMsg('');
    setFarewellMsg('');
    setBhStart('');
    setBhEnd('');
    setBhDays([1, 2, 3, 4, 5]);
  };

  const applyTemplate = (t: any) => {
    setPersona(t.templateBody || t.template_body || '');
    if (t.welcomeMsgTemplate || t.welcome_msg_template) {
      setWelcomeMsg(t.welcomeMsgTemplate || t.welcome_msg_template);
    }
    if (!editingId && t.name) setName(t.name);
    toast.info(`Plantilla "${t.name}" aplicada. Ajustala a tu gusto y guardá.`);
  };

  const buildBusinessHoursJson = () => {
    if (!bhStart || !bhEnd) return '{}';
    return JSON.stringify({ start: bhStart, end: bhEnd, days: bhDays, tz: 'America/Argentina/Buenos_Aires' });
  };

  const loadBusinessHours = (raw: string) => {
    try {
      const bh = JSON.parse(raw || '{}');
      setBhStart(bh.start || '');
      setBhEnd(bh.end || '');
      setBhDays(Array.isArray(bh.days) && bh.days.length ? bh.days.map(Number) : [1, 2, 3, 4, 5]);
    } catch {
      setBhStart('');
      setBhEnd('');
      setBhDays([1, 2, 3, 4, 5]);
    }
  };

  const createOrUpdateAgent = async () => {
    if (!name.trim()) return toast.error('Poné un nombre al asistente');
    if (!persona.trim()) return toast.error('Completá las instrucciones (o elegí una plantilla)');
    setSaving(true);
    try {
      const payload = {
        name,
        persona,
        language: 'es',
        model: 'gpt-4o-mini',
        welcomeMsg,
        offhoursMsg,
        farewellMsg,
        businessHoursJson: buildBusinessHoursJson()
      };
      if (editingId) {
        await api.put(`/ai/agents/${editingId}`, payload);
        toast.success('Agente IA actualizado');
      } else {
        await api.post('/ai/agents', { ...payload, isActive: true });
        toast.success('Agente IA guardado y activado');
      }
      resetForm();
      fetchAgents();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || (editingId ? 'No se pudo actualizar' : 'No se pudo guardar'));
    } finally {
      setSaving(false);
    }
  };

  const editAgent = (agent: any) => {
    setEditingId(agent.id);
    setName(agent.name || '');
    setPersona(agent.persona || '');
    setWelcomeMsg(agent.welcome_msg || '');
    setOffhoursMsg(agent.offhours_msg || '');
    setFarewellMsg(agent.farewell_msg || '');
    loadBusinessHours(agent.business_hours_json || '{}');
  };

  const toggleAgent = async (agent: any) => {
    try {
      await api.put(`/ai/agents/${agent.id}`, { isActive: !agent.is_active });
      toast.success(agent.is_active ? 'Agente desactivado' : 'Agente activado (los demás se desactivan)');
      fetchAgents();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo actualizar estado');
    }
  };

  const deleteAgent = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/ai/agents/${deleteTarget.id}`);
      toast.success('Agente eliminado');
      setDeleteTarget(null);
      if (editingId === deleteTarget.id) resetForm();
      fetchAgents();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'No se pudo eliminar');
    }
  };

  const searchKb = async () => {
    setSearching(true);
    try {
      const { data } = await api.post('/ai/rag/search', { query: searchQuery, limit: 5 });
      setSearchResults(Array.isArray(data) ? data : []);
    } catch {
      toast.error('No se pudo buscar en conocimiento');
    } finally {
      setSearching(false);
    }
  };

  const sendTestMessage = async () => {
    const msg = testInput.trim();
    if (!msg || testSending) return;
    setTestSending(true);
    setTestInput('');
    const history = [...testMessages];
    setTestMessages((prev) => [...prev, { fromMe: false, body: msg }]);
    try {
      const { data } = await api.post('/ai/agents/test-chat', { message: msg, history });
      setTestMessages((prev) => [...prev, { fromMe: true, body: data?.reply || '(sin respuesta)' }]);
    } catch (e: any) {
      const detail = e?.response?.data?.detail || 'Error al probar el agente';
      setTestMessages((prev) => [...prev, { fromMe: true, body: `⚠ ${detail}` }]);
    } finally {
      setTestSending(false);
    }
  };

  const toggleDay = (iso: number) => {
    setBhDays((prev) => (prev.includes(iso) ? prev.filter((d) => d !== iso) : [...prev, iso].sort()));
  };

  return (
    <Box>
      <Typography variant='h4' gutterBottom>
        Agente IA
      </Typography>
      <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
        Configurá cómo responde tu asistente y probalo acá mismo antes de que hable con clientes reales.
      </Typography>

      {!activeAgent && agents.length > 0 && (
        <Alert severity='warning' sx={{ mb: 2 }}>
          Ningún agente está activo: WhatsApp responde con la configuración por defecto. Activá uno desde la tabla de abajo.
        </Alert>
      )}

      <Grid container spacing={2}>
        <Grid item xs={12} md={5}>
          <Paper className='anim-fade-up anim-fade-up-1' sx={{ p: 2.5 }}>
            <Typography variant='h6'>{editingId ? `Editando agente #${editingId}` : 'Configuración principal'}</Typography>

            {!editingId && (
              <Box sx={{ mt: 1.5, mb: 0.5 }}>
                <Typography variant='caption' color='text.secondary'>
                  Empezá desde una plantilla:
                </Typography>
                <Stack direction='row' spacing={1} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                  {personaTemplates.map((t: any) => (
                    <Chip
                      key={t.id || t.slug}
                      label={t.name}
                      size='small'
                      variant='outlined'
                      onClick={() => applyTemplate(t)}
                      title={t.description || ''}
                    />
                  ))}
                </Stack>
              </Box>
            )}

            <Stack spacing={1.5} sx={{ mt: 1.5 }}>
              <TextField label='Nombre del asistente' value={name} onChange={(e) => setName(e.target.value)} />
              <TextField
                label='Mensaje de bienvenida'
                helperText='Lo primero que recibe el cliente al saludar.'
                value={welcomeMsg}
                onChange={(e) => setWelcomeMsg(e.target.value)}
                multiline
                minRows={2}
              />
              <TextField
                label='Instrucciones del asistente'
                helperText='En lenguaje natural: qué hace, qué pregunta y en qué orden. Ej: "Pedí zona, presupuesto y tipo de propiedad, de a uno por mensaje".'
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                multiline
                minRows={4}
              />
              <TextField
                label='Mensaje fuera de horario (opcional)'
                helperText='Se envía una vez si escriben fuera del horario de atención.'
                value={offhoursMsg}
                onChange={(e) => setOffhoursMsg(e.target.value)}
                multiline
                minRows={2}
              />
              <TextField
                label='Mensaje de despedida (opcional)'
                helperText='Respuesta cuando el cliente se despide.'
                value={farewellMsg}
                onChange={(e) => setFarewellMsg(e.target.value)}
              />

              <Box>
                <Typography variant='caption' color='text.secondary'>
                  Horario de atención (vacío = siempre disponible)
                </Typography>
                <Stack direction='row' spacing={1} sx={{ mt: 0.5 }}>
                  <TextField label='Desde' type='time' size='small' value={bhStart} onChange={(e) => setBhStart(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ width: 130 }} />
                  <TextField label='Hasta' type='time' size='small' value={bhEnd} onChange={(e) => setBhEnd(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ width: 130 }} />
                </Stack>
                <Stack direction='row' spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
                  {DAY_LABELS.map((d) => (
                    <Chip
                      key={d.iso}
                      label={d.label}
                      size='small'
                      color={bhDays.includes(d.iso) ? 'primary' : 'default'}
                      variant={bhDays.includes(d.iso) ? 'filled' : 'outlined'}
                      onClick={() => toggleDay(d.iso)}
                    />
                  ))}
                </Stack>
              </Box>

              <Stack direction='row' spacing={1}>
                <Button variant='contained' onClick={createOrUpdateAgent} disabled={saving}>
                  {saving ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Guardar asistente'}
                </Button>
                {editingId && (
                  <Button variant='outlined' onClick={resetForm} disabled={saving}>
                    Cancelar edición
                  </Button>
                )}
              </Stack>
            </Stack>
          </Paper>
        </Grid>

        <Grid item xs={12} md={7}>
          <Paper className='anim-fade-up anim-fade-up-2' sx={{ p: 2.5, mb: 2 }}>
            <Stack direction='row' justifyContent='space-between' alignItems='center'>
              <Typography variant='h6'>Probar el agente</Typography>
              {testMessages.length > 0 && (
                <Button size='small' onClick={() => setTestMessages([])}>Limpiar</Button>
              )}
            </Stack>
            <Typography variant='caption' color='text.secondary'>
              Simulá una conversación real. No envía WhatsApp ni guarda nada.
            </Typography>
            <Box sx={{ height: 230, overflowY: 'auto', my: 1.5, p: 1, border: '1px solid rgba(232,160,32,0.12)', borderRadius: 2 }}>
              {testMessages.length === 0 ? (
                <Typography variant='body2' color='text.secondary' sx={{ textAlign: 'center', mt: 8 }}>
                  Escribí como si fueras un cliente, por ejemplo: "Hola, busco un depto en alquiler"
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {testMessages.map((m, i) => (
                    <Box key={i} className='msg-in' sx={{ display: 'flex', justifyContent: m.fromMe ? 'flex-start' : 'flex-end' }}>
                      <Paper variant='outlined' sx={{ p: 1, px: 1.5, maxWidth: '80%', bgcolor: m.fromMe ? 'rgba(232,160,32,0.10)' : 'rgba(255,255,255,0.04)', borderColor: m.fromMe ? 'rgba(232,160,32,0.18)' : 'rgba(255,255,255,0.08)', borderRadius: m.fromMe ? '12px 12px 12px 3px' : '12px 12px 3px 12px' }}>
                        <Typography variant='body2' sx={{ whiteSpace: 'pre-wrap' }}>{m.body}</Typography>
                      </Paper>
                    </Box>
                  ))}
                  {testSending && (
                    <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                      <CircularProgress size={16} sx={{ m: 1 }} />
                    </Box>
                  )}
                  <div ref={testEndRef} />
                </Stack>
              )}
            </Box>
            <Stack direction='row' spacing={1}>
              <TextField
                fullWidth
                size='small'
                placeholder='Mensaje de prueba...'
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendTestMessage();
                  }
                }}
                disabled={testSending}
              />
              <Button variant='contained' onClick={sendTestMessage} disabled={testSending || !testInput.trim()}>
                Enviar
              </Button>
            </Stack>
          </Paper>

          <Paper className='anim-fade-up anim-fade-up-3' sx={{ p: 2.5, mb: 2 }}>
            <Typography variant='h6'>Estado del Agente IA</Typography>
            {activeAgent ? (
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Stack direction='row' spacing={1} alignItems='center'>
                  <Chip size='small' color='success' label='Activo' />
                  <Typography variant='body2'><strong>{activeAgent.name}</strong></Typography>
                </Stack>
                <Typography variant='body2' sx={{ color: 'text.secondary' }}>
                  {activeAgent.persona?.slice(0, 180)}{(activeAgent.persona?.length || 0) > 180 ? '…' : ''}
                </Typography>
                <Stack direction='row' spacing={1}>
                  <Button size='small' variant='outlined' onClick={() => editAgent(activeAgent)}>
                    Editar
                  </Button>
                  <Button size='small' onClick={() => toggleAgent(activeAgent)}>
                    Desactivar
                  </Button>
                </Stack>
              </Stack>
            ) : (
              <Typography sx={{ mt: 1 }} variant='body2' color='text.secondary'>
                {agents.length === 0 ? 'Todavía no hay agentes creados. Creá el primero con una plantilla.' : 'Ningún agente activo.'}
              </Typography>
            )}
          </Paper>

          <Paper className='anim-fade-up anim-fade-up-4' sx={{ p: 2.5 }}>
            <Typography variant='h6'>Búsqueda inteligente en Conocimiento</Typography>
            <Stack direction='row' spacing={1.5} sx={{ mt: 1 }}>
              <TextField fullWidth label='Probá una pregunta real del cliente' value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
              <Button variant='outlined' onClick={searchKb} disabled={searching}>
                {searching ? <CircularProgress size={18} /> : 'Buscar'}
              </Button>
            </Stack>
            <Divider sx={{ my: 2 }} />
            <Stack spacing={1}>
              {searchResults.length === 0 ? (
                <Typography variant='body2' color='text.secondary'>
                  Sin resultados aún.
                </Typography>
              ) : (
                searchResults.map((r, idx) => (
                  <Paper key={idx} variant='outlined' className='anim-scale-in hover-lift' sx={{ p: 1.25 }}>
                    <Typography variant='caption'>
                      {r.title} · {r.category} · relevancia {Number(r.score || r.similarity || 0).toFixed(2)}
                    </Typography>
                    <Typography variant='body2'>{r.chunk_text}</Typography>
                  </Paper>
                ))
              )}
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      <Paper className='anim-fade-up anim-fade-up-5' sx={{ p: 2.5, mt: 2 }}>
        <Typography variant='h6'>Historial de agentes</Typography>
        <Table size='small'>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Nombre</TableCell>
              <TableCell>Estado</TableCell>
              <TableCell>Acción</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={4}>Cargando...</TableCell>
              </TableRow>
            ) : agents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>Sin agentes</TableCell>
              </TableRow>
            ) : (
              agents.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.id}</TableCell>
                  <TableCell>{a.name}</TableCell>
                  <TableCell>
                    <Chip size='small' color={a.is_active ? 'success' : 'default'} label={a.is_active ? 'Activo' : 'Inactivo'} />
                  </TableCell>
                  <TableCell>
                    <Stack direction='row' spacing={1}>
                      <Button size='small' variant='outlined' onClick={() => editAgent(a)}>
                        Editar
                      </Button>
                      <Button size='small' onClick={() => toggleAgent(a)}>
                        {a.is_active ? 'Desactivar' : 'Activar'}
                      </Button>
                      <Button size='small' color='error' onClick={() => setDeleteTarget(a)}>
                        Eliminar
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Paper>

      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Eliminar agente IA</DialogTitle>
        <DialogContent>
          <Typography variant='body2'>
            ¿Seguro que querés eliminar <strong>{deleteTarget?.name}</strong>? Esta acción no se puede deshacer.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancelar</Button>
          <Button color='error' variant='contained' onClick={deleteAgent}>Eliminar</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default AIAgents;
