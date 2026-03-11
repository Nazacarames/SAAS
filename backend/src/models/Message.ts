import {
    Table,
    Column,
    CreatedAt,
    UpdatedAt,
    Model,
    PrimaryKey,
    AllowNull,
    Default,
    ForeignKey,
    BelongsTo,
    DataType
} from "sequelize-typescript";
import Ticket from "./Ticket";
import Contact from "./Contact";

@Table({ tableName: "messages" })
class Message extends Model {
    @PrimaryKey
    @Column
    id: string; // WhatsApp message ID

    @AllowNull(false)
    @Column(DataType.TEXT)
    body: string;

    @Default(0)
    @Column
    ack: number; // 0-5 delivery status

    @Default(false)
    @Column
    read: boolean;

    @Default(false)
    @Column
    fromMe: boolean;

    @Default("chat")
    @Column
    mediaType: string;

    @Column
    mediaUrl: string;

    @Column
    providerMessageId: string;

    @ForeignKey(() => Ticket)
    @AllowNull(true)
    @Column(DataType.INTEGER)
    ticketId: number;

    @BelongsTo(() => Ticket)
    ticket: Ticket;

    @ForeignKey(() => Contact)
    @Column
    contactId: number;

    @BelongsTo(() => Contact)
    contact: Contact;

    @ForeignKey(() => Message)
    @Column
    quotedMsgId: string;

    @BelongsTo(() => Message, "quotedMsgId")
    quotedMsg: Message;

    @CreatedAt
    createdAt: Date;

    @UpdatedAt
    updatedAt: Date;
}

export default Message;
