import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import 'dotenv/config'

const app = express()
const port = process.env.PORT

app.use(bodyParser.urlencoded({ extended: true }))

const bitrixApi = axios.create({ baseURL: process.env.BITRIX_API_URL });
const chatappApi = axios.create({ baseURL: process.env.CHATAPP_API_URL });
const CHATAPP_LICENSE_ID = process.env.CHATAPP_LICENSE_ID;
const chatappCredentials = {
    email: process.env.CHATAPP_EMAIL,
    appId: process.env.CHATAPP_APP_ID,
    password: process.env.CHATAPP_PASSWORD,
}

app.post('/bitrix-handler', async (req: Request, res: Response) => {
  try {
    const bodyData = req.body
    const event = bodyData.event
    const taskId = event == 'ONTASKCOMMENTADD' ? bodyData.data.FIELDS_AFTER.TASK_ID : bodyData.data.FIELDS_AFTER.ID

    const response = await bitrixApi.get('/tasks.task.get', {
      params: {
        taskId: taskId,
      }
    })

    const task = response.data.result.task
    
    const taskItemsResponse = await bitrixApi.get('/task.item.getdata.json', {
        params: {
          taskId: taskId
        }
    })

    const contactIDs: string[] = taskItemsResponse.data.result.UF_CRM_TASK.map((i: string) => i.replace(/[^\d]/g, ''))

    const contacts = await Promise.all(contactIDs.map(async (id) => {
        const response = await bitrixApi.get('/crm.contact.get', {
            params: { id }
        })
        return response.data.result?.PHONE[0]?.VALUE
    }))
    
    const chatappTokensResponse = await chatappApi.post('/tokens', chatappCredentials)
    const chatappToken = chatappTokensResponse.data.data.accessToken

    let message = ''

    if (bodyData.event == 'ONTASKCOMMENTADD') {
        const comment = (await bitrixApi.post('task.commentitem.get.json', [
            bodyData.data.FIELDS_AFTER.TASK_ID,
            bodyData.data.FIELDS_AFTER.ID,
        ])).data.result
        message = `*${comment.AUTHOR_NAME}* adicionou um comentário a tarefa *${task.title}*:\n${comment.POST_MESSAGE}`
    }

    if (bodyData.event == 'ONTASKADD') {
        message = `Uma nova tarefa foi criada: ${task.title}`
    }

    for (const contact of contacts) {
        if (contact && contact.length) {
            try {
                await chatappApi.post(
                    `licenses/${CHATAPP_LICENSE_ID}/messengers/grWhatsApp/chats/${contact}/messages/text`,
                    { text: message },
                    { headers: { Authorization: chatappToken, }},
                )
            } catch (e: any) {
                console.error(e)
            }
        }
    }

    res.status(200).send('OK')
  } catch (error: any) {
    console.error(error.response.data)
    res.status(500).send('Erro ao processar requisição.')
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});

export default app;
