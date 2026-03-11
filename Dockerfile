FROM python:3.12-slim

WORKDIR /app

# Dependências do sistema (necessário para psutil em alguns ambientes)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Cria usuário sem privilégios para rodar a aplicação
RUN useradd -m -u 1001 -s /bin/sh appuser

# Instala dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copia o projeto
COPY . .

# Cria o diretório do banco de dados e ajusta permissões
RUN mkdir -p bd && chown -R appuser:appuser /app

# Nota: Roda como root para acesso ao Docker socket (/var/run/docker.sock)
# O socket é montado como read-only via custom_docker_run_options no Coolify

# Expõe a porta
EXPOSE 3001

# Variáveis de ambiente padrão para produção
ENV HOST=0.0.0.0
ENV PORT=3001

CMD ["python", "controler.py"]
