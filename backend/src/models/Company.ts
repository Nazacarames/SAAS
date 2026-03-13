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
    HasMany
} from "sequelize-typescript";
import User from "./User";
import Whatsapp from "./Whatsapp";
import Contact from "./Contact";
import Ticket from "./Ticket";
import Queue from "./Queue";

@Table({ tableName: "companies" })
class Company extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column
    id: number;

    @AllowNull(false)
    @Column
    name: string;

    @Column
    email: string;

    @Column
    phone: string;

    @Default(true)
    @Column
    status: boolean;

    @Column
    integrationApiKey: string;

    @CreatedAt
    createdAt: Date;

    @UpdatedAt
    updatedAt: Date;

    @HasMany(() => User, { onDelete: "CASCADE", hooks: true })
    users: User[];

    @HasMany(() => Whatsapp, { onDelete: "CASCADE", hooks: true })
    whatsapps: Whatsapp[];

    @HasMany(() => Contact, { onDelete: "CASCADE", hooks: true })
    contacts: Contact[];

    @HasMany(() => Ticket, { onDelete: "CASCADE", hooks: true })
    tickets: Ticket[];

    @HasMany(() => Queue, { onDelete: "CASCADE", hooks: true })
    queues: Queue[];
}

export default Company;
