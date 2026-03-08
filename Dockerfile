FROM python:3.12-slim

WORKDIR /app

# Dependências do sistema (necessário para psutil em alguns ambientes)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Instala dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copia o projeto
COPY . .

# Cria o diretório do banco de dados
RUN mkdir -p bd

# Expõe a porta
EXPOSE 3001

# Variáveis de ambiente padrão para produção
ENV HOST=0.0.0.0
ENV PORT=3001

CMD ["python", "controler.py"]
