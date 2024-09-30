import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const app = express();
const port = process.env.PORT;

app.use(bodyParser.urlencoded({ extended: true }));

const bitrixApi = axios.create({ baseURL: process.env.BITRIX_API_URL });
const chatappApi = axios.create({ baseURL: process.env.CHATAPP_API_URL });
const CHATAPP_LICENSE_ID = process.env.CHATAPP_LICENSE_ID;
const chatappCredentials = {
  email: process.env.CHATAPP_EMAIL,
  appId: process.env.CHATAPP_APP_ID,
  password: process.env.CHATAPP_PASSWORD,
};

app.post('/bitrix-handler', async (req: Request, res: Response) => {
  try {
    const bodyData = req.body;
    const event = bodyData.event;
    const taskId = event == 'ONTASKCOMMENTADD' ? bodyData.data.FIELDS_AFTER.TASK_ID : bodyData.data.FIELDS_AFTER.ID;

    const response = await bitrixApi.get('/tasks.task.get', {
      params: {
        taskId: taskId,
      },
    });

    const task = response.data.result.task;

    const taskItemsResponse = await bitrixApi.get('/task.item.getdata.json', {
      params: {
        taskId: taskId,
      },
    });

    let contactIDs: string[] = taskItemsResponse.data.result.UF_CRM_TASK.map((i: string) => i.replace(/[^\d]/g, ''));
    
    const storagePath = path.join(__dirname, 'storage', `${taskId}.json`)

    if (event === 'ONTASKUPDATE') {
      let previousContactIDs = []
      let fileExists = fs.existsSync(storagePath)
      if (fileExists) {
        previousContactIDs = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
      }
    
      contactIDs = contactIDs.filter(id => !previousContactIDs.includes(id))
    
      fs.mkdirSync(path.dirname(storagePath), { recursive: true })
      fs.writeFileSync(storagePath, JSON.stringify(contactIDs, null, 2))
    
      if (!fileExists) {
        throw new Error('Arquivo de armazenamento não encontrado.')
      }
    } else {
      fs.mkdirSync(path.dirname(storagePath), { recursive: true })
      fs.writeFileSync(storagePath, JSON.stringify(contactIDs, null, 2))
    }

    const contacts: string[] = [];

    for (const id of contactIDs) {
      try {
        const response = await bitrixApi.get('/crm.contact.get', {
          params: { id },
        });
        contacts.push(response.data.result?.PHONE[0]?.VALUE);
      } catch (e) {
        console.error(e);
      }
    }

    const chatappTokensResponse = await chatappApi.post('/tokens', chatappCredentials);
    const chatappToken = chatappTokensResponse.data.data.accessToken;

    let message = '';

    if (bodyData.event == 'ONTASKCOMMENTADD') {
      const comment = (await bitrixApi.post('task.commentitem.get.json', [
        bodyData.data.FIELDS_AFTER.TASK_ID,
        bodyData.data.FIELDS_AFTER.ID,
      ])).data.result;
      if (comment.POST_MESSAGE.toLowerCase().includes('/privar')) {
        return res.status(400).send('Mensagem incluí texto privado');
      }
      message = `*${comment.AUTHOR_NAME}* adicionou um comentário a tarefa *${task.title}*:\n${comment.POST_MESSAGE}`
        .replace(/\[USER=\d+\]/g, '_')
        .replaceAll('[/USER]', '_');
      if (comment.ATTACHED_OBJECTS) {
        const objects: any = Object.values(comment.ATTACHED_OBJECTS);
        for (const object of objects) {
          const fileResponse = await bitrixApi.get('/disk.file.getexternallink', {
            params: { id: object.FILE_ID },
          });
          const url = fileResponse.data.result;
          message = message + `\n\n${url}`;
        }
      }
    }

    if (bodyData.event == 'ONTASKADD') {
      message = `Olá prezado cliente, uma nova tarefa foi registrada: *${task.title}*`;
      if (task.durationPlan > 0) {
        const durationType =
          task.durationType.includes('d') ? 'dias' :
            task.durationType.includes('h') ? 'horas' :
              task.durationType.includes('m') ? 'minutos' : '';
        message = message + `\nA tarefa levará ${task.durationPlan} ${durationType}`;
      }
      if (task.deadline) {
        message = message + `\nO prazo é até ` + new Date(task.deadline).toLocaleString('pt-BR');
      }
      message = message + `\n${task.description}`;
      message = message + '\n\nPara mais detalhes entre em contato conosco.';
    }

    if (bodyData.event == 'ONTASKUPDATE') {
      const comments = (await bitrixApi.post('task.commentitem.getlist.json', {
        taskId: taskId,
      })).data.result
      message = `Olá prezado cliente, você foi adicionado como observador a tarefa: *${task.title}*\n\nHistórico da tarefa:\n`;
      message = message + comments.map((comment: any) => {
        return `*${comment.AUTHOR_NAME}*:\n${comment.POST_MESSAGE}`
      }).join('\n\n')
    }

    for (const contact of contacts) {
      if (contact && contact.length) {
        try {
          await chatappApi.post(
            `licenses/${CHATAPP_LICENSE_ID}/messengers/grWhatsApp/chats/${contact}/messages/text`,
            { text: message },
            { headers: { Authorization: chatappToken } },
          );
        } catch (e: any) {
          console.error(e);
        }
      }
    }

    res.status(200).send('OK');
  } catch (error: any) {
    console.error(error);
    res.status(500).send('Erro ao processar requisição.');
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});

export default app;
