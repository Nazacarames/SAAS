import {
    Table,
    Column,
    CreatedAt,
    UpdatedAt,
    Model,
    PrimaryKey,
    AutoIncrement,
    AllowNull,
    Default,
    ForeignKey,
    BelongsTo,
    HasMany
} from "sequelize-typescript";
import Contact from "./Contact";
import User from "./User";
import Whatsapp from "./Whatsapp";
import Company from "./Company";
import Queue from "./Queue";
import Message from "./Message";

@Table({ tableName: "tickets" })
class Ticket extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column
    id: number;

    @Default("pending")
    @Column
    status: string; // 'pending' | 'open' | 'closed'

    @Default(0)
    @Column
    unreadMessages: number;

    @Column
    lastMessage: string;

    @Default(false)
    @Column
    isGroup: boolean;

    @Default(true)
    @Column
    bot_enabled: boolean;

    @Default(false)
    @Column
    human_override: boolean;

    @ForeignKey(() => Contact)
    @AllowNull(false)
    @Column
    contactId: number;

    @BelongsTo(() => Contact)
    contact: Contact;

    @ForeignKey(() => User)
    @Column
    userId: number;

    @BelongsTo(() => User)
    user: User;

    @ForeignKey(() => Whatsapp)
    @AllowNull(false)
    @Column
    whatsappId: number;

    @BelongsTo(() => Whatsapp)
    whatsapp: Whatsapp;

    @ForeignKey(() => Queue)
    @Column
    queueId: number;

    @BelongsTo(() => Queue)
    queue: Queue;

    @ForeignKey(() => Company)
    @AllowNull(false)
    @Column
    companyId: number;

    @BelongsTo(() => Company)
    company: Company;

    @HasMany(() => Message)
    messages: Message[];

    @CreatedAt
    createdAt: Date;

    @UpdatedAt
    updatedAt: Date;
}

export default Ticket;
