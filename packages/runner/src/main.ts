const port = parseInt(process.env.PORT || '5200', 10);
const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';

console.log(`synth-runner starting...`);
console.log(`  backend: ${backendUrl}`);

// TODO: реализация раннера — Gateway, Engine Manager, LLM Proxy
